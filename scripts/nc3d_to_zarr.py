#!/usr/bin/env python3
"""Convert a 3D NetCDF file (time, depth, curvilinear y/x grid) to a web-friendly Zarr store.

This is the depth-aware sibling of ``nc_to_zarr.py``. It targets CROCO-style ocean
model output where:

* the horizontal grid is *curvilinear* (``latitude(y, x)`` / ``longitude(y, x)``),
* there is a vertical ``depth`` dimension, and
* several data variables share the ``(time, depth, y, x)`` layout
  (plus surface variables shaped ``(time, y, x)``).

The MapLibre Zarr overlay expects **regular 1D ``lat``/``lon`` axes**, so the
curvilinear grid is resampled onto a regular lat/lon grid using a barycentric
(linear) interpolation whose triangulation/weights are computed once and reused
for every time/depth slice.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import numpy as np
import xarray as xr
from scipy.spatial import Delaunay

try:
    from pyproj import CRS
except Exception:  # pragma: no cover - optional dependency
    CRS = None


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = WORKSPACE_ROOT / "scripts" / "d1_temp_salt_uv_z_all.nc"
DEFAULT_OUTPUT = WORKSPACE_ROOT / "public" / "zarr-data" / "d1_temp_salt_uv_z_all.zarr"

LATITUDE_NAMES = ("lat", "latitude", "lat_rho", "y")
LONGITUDE_NAMES = ("lon", "longitude", "lon_rho", "x")
TIME_NAMES = ("time", "valid_time")
DEPTH_NAMES = ("depth", "z", "zlev", "level", "lev")


def normalize_text(value: object) -> str:
    return str(value).strip().lower() if value is not None else ""


def looks_like_latitude(name: str, variable: xr.DataArray) -> bool:
    standard_name = normalize_text(variable.attrs.get("standard_name"))
    units = normalize_text(variable.attrs.get("units"))
    return (
        normalize_text(name) in {"lat", "latitude", "lat_rho"}
        or standard_name == "latitude"
        or "degree_north" in units
        or "degrees_north" in units
    )


def looks_like_longitude(name: str, variable: xr.DataArray) -> bool:
    standard_name = normalize_text(variable.attrs.get("standard_name"))
    units = normalize_text(variable.attrs.get("units"))
    return (
        normalize_text(name) in {"lon", "longitude", "lon_rho"}
        or standard_name == "longitude"
        or "degree_east" in units
        or "degrees_east" in units
    )


def find_2d_coordinate(ds: xr.Dataset, predicate, preferred: tuple[str, ...]) -> str | None:
    """Find a 2D coordinate variable, preferring well-known names."""
    for name in preferred:
        if name in ds.variables and ds[name].ndim == 2 and predicate(name, ds[name]):
            return name
    for name in ds.variables:
        variable = ds[name]
        if variable.ndim == 2 and predicate(name, variable):
            return name
    return None


def resolve_input_path(explicit_path: str | None) -> Path:
    if explicit_path:
        path = Path(explicit_path).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Input file not found: {path}")
        return path
    if DEFAULT_INPUT.exists():
        return DEFAULT_INPUT
    raise FileNotFoundError(f"Could not find an input NetCDF file. Looked for: {DEFAULT_INPUT}")


def build_crs_variable() -> xr.DataArray:
    attrs = {
        "grid_mapping_name": "latitude_longitude",
        "long_name": "CRS definition",
        "epsg_code": "EPSG:4326",
        "semi_major_axis": 6378137.0,
        "inverse_flattening": 298.257223563,
    }
    if CRS is not None:
        crs = CRS.from_epsg(4326)
        attrs["spatial_ref"] = crs.to_wkt()
        attrs["crs_wkt"] = crs.to_wkt()
    return xr.DataArray(np.int32(0), attrs=attrs, name="crs")


def normalize_longitudes_1d(lon: np.ndarray, mode: str) -> np.ndarray:
    lon = np.asarray(lon, dtype=np.float64)
    if mode == "0_360":
        return np.where(lon < 0, lon + 360.0, lon)
    if mode == "-180_180":
        return ((lon + 180.0) % 360.0) - 180.0
    raise ValueError(f"Unsupported longitude mode: {mode}")


# --------------------------------------------------------------------------- #
# Curvilinear -> regular regridding
# --------------------------------------------------------------------------- #


class BarycentricRegridder:
    """Precomputes linear (barycentric) interpolation weights from a curvilinear
    source grid onto a regular target grid, then applies them to many slices."""

    def __init__(self, src_lon2d: np.ndarray, src_lat2d: np.ndarray, tgt_lon1d: np.ndarray, tgt_lat1d: np.ndarray):
        self.src_shape = src_lon2d.shape
        self.tgt_lat = np.asarray(tgt_lat1d, dtype=np.float64)
        self.tgt_lon = np.asarray(tgt_lon1d, dtype=np.float64)
        self.tgt_shape = (self.tgt_lat.size, self.tgt_lon.size)

        src_points = np.column_stack([src_lon2d.ravel(), src_lat2d.ravel()])
        triangulation = Delaunay(src_points)

        grid_lon, grid_lat = np.meshgrid(self.tgt_lon, self.tgt_lat)
        target_points = np.column_stack([grid_lon.ravel(), grid_lat.ravel()])

        simplices = triangulation.find_simplex(target_points)
        self.outside = simplices < 0

        # Clamp negative simplex indices so the gather below stays in-bounds; the
        # corresponding outputs are masked to NaN via ``self.outside`` afterwards.
        safe_simplices = np.where(self.outside, 0, simplices)

        transform = triangulation.transform[safe_simplices]
        delta = target_points - transform[:, 2]
        bary = np.einsum("mjk,mk->mj", transform[:, :2], delta)
        self.weights = np.column_stack([bary, 1.0 - bary.sum(axis=1)])  # (M, 3)
        self.vertices = triangulation.simplices[safe_simplices]          # (M, 3)

    def regrid(self, values2d: np.ndarray) -> np.ndarray:
        flat = np.asarray(values2d, dtype=np.float64).ravel()
        vertex_values = flat[self.vertices]  # (M, 3)
        result = np.einsum("mj,mj->m", vertex_values, self.weights)
        invalid = self.outside | ~np.isfinite(vertex_values).all(axis=1)
        result[invalid] = np.nan
        return result.reshape(self.tgt_shape)

    def regrid_nd(self, array: np.ndarray) -> np.ndarray:
        """Regrid an array whose trailing two axes are (y, x)."""
        leading_shape = array.shape[:-2]
        flat_leading = array.reshape((-1, *self.src_shape))
        out = np.empty((flat_leading.shape[0], *self.tgt_shape), dtype=np.float32)
        for index in range(flat_leading.shape[0]):
            out[index] = self.regrid(flat_leading[index]).astype(np.float32)
        return out.reshape((*leading_shape, *self.tgt_shape))


# --------------------------------------------------------------------------- #
# Time / encoding helpers (shared shape with nc_to_zarr.py)
# --------------------------------------------------------------------------- #


def format_cf_reference_time(value: np.datetime64) -> str:
    return np.datetime_as_string(value.astype("datetime64[s]"), unit="s").replace("T", " ")


def encode_time_coordinate(ds: xr.Dataset) -> xr.Dataset:
    if "time" not in ds.coords:
        return ds

    time_values = np.asarray(ds["time"].values)
    if time_values.size == 0:
        ds = ds.assign_coords(time=("time", np.asarray([], dtype=np.int32)))
        ds["time"].attrs.update({
            "long_name": "time",
            "standard_name": "time",
            "axis": "T",
            "units": "hours since 1970-01-01 00:00:00",
        })
        ds["time"].encoding = {}
        return ds

    time_seconds = time_values.astype("datetime64[s]")
    reference_time = time_seconds[0]
    offsets = ((time_seconds - reference_time) / np.timedelta64(1, "h")).astype(np.int32)

    time_attrs = dict(ds["time"].attrs)
    time_attrs.update({
        "long_name": time_attrs.get("long_name", "time"),
        "standard_name": "time",
        "axis": "T",
        "units": f"hours since {format_cf_reference_time(reference_time)}",
    })
    time_attrs.pop("calendar", None)

    ds = ds.assign_coords(time=("time", offsets, time_attrs))
    ds["time"].encoding = {}
    return ds


def build_encoding(ds: xr.Dataset) -> dict[str, dict[str, object]]:
    encoding: dict[str, dict[str, object]] = {}
    for name, variable in ds.variables.items():
        if variable.dtype.kind in {"O", "U", "S"}:
            continue

        chunks: list[int] = []
        for dim in variable.dims:
            dim_size = ds.sizes[dim]
            if dim in {"time", "valid_time"}:
                chunks.append(1)
            elif dim in {"z", "zlev", "level", "depth"}:
                chunks.append(1)
            elif dim in {"lat", "lon"}:
                chunks.append(min(256, dim_size))
            else:
                chunks.append(min(32, dim_size))

        entry: dict[str, object] = {}
        if chunks:
            entry["chunks"] = tuple(chunks)
        if name == "time":
            entry["dtype"] = "int32"
        encoding[name] = entry
    return encoding


# --------------------------------------------------------------------------- #
# Dataset preparation
# --------------------------------------------------------------------------- #


def infer_depth_name(ds: xr.Dataset) -> str | None:
    for name in DEPTH_NAMES:
        if name in ds.dims:
            return name
    return None


def infer_time_name(ds: xr.Dataset) -> str | None:
    for name in TIME_NAMES:
        if name in ds.dims or name in ds.coords:
            return name
    return None


def prepare_dataset(
    input_path: Path,
    lon_mode: str,
    nx: int | None,
    ny: int | None,
    variable_name: str | None,
) -> tuple[xr.Dataset, str]:
    source = xr.open_dataset(input_path, decode_cf=True, mask_and_scale=True)

    lat_name = find_2d_coordinate(source, looks_like_latitude, LATITUDE_NAMES)
    lon_name = find_2d_coordinate(source, looks_like_longitude, LONGITUDE_NAMES)
    if not lat_name or not lon_name:
        raise ValueError("Could not detect 2D latitude/longitude coordinates from the NetCDF file.")

    src_lat = np.asarray(source[lat_name].values, dtype=np.float64)
    src_lon = np.asarray(source[lon_name].values, dtype=np.float64)
    if src_lat.shape != src_lon.shape or src_lat.ndim != 2:
        raise ValueError("Latitude/longitude must be matching 2D arrays for curvilinear regridding.")

    row_dim, col_dim = source[lat_name].dims  # (y, x)

    target_ny = ny or src_lat.shape[0]
    target_nx = nx or src_lat.shape[1]

    target_lon = np.linspace(float(np.nanmin(src_lon)), float(np.nanmax(src_lon)), target_nx)
    target_lat = np.linspace(float(np.nanmin(src_lat)), float(np.nanmax(src_lat)), target_ny)

    print(
        f"Source grid     : curvilinear {src_lat.shape[0]} x {src_lat.shape[1]} "
        f"({lat_name}/{lon_name})"
    )
    print(f"Target grid     : regular {target_ny} x {target_nx} (lat x lon)")
    print("Building interpolation weights (Delaunay)...")
    regridder = BarycentricRegridder(src_lon, src_lat, target_lon, target_lat)

    # Regrid every (y, x)-shaped data variable.
    data_vars: dict[str, xr.DataArray] = {}
    primary_candidate: str | None = None

    for name, data_var in source.data_vars.items():
        dims = data_var.dims
        if row_dim not in dims or col_dim not in dims:
            continue
        if dims[-2:] != (row_dim, col_dim):
            # Move the (y, x) axes to the end so regrid_nd can operate on them.
            data_var = data_var.transpose(..., row_dim, col_dim)
            dims = data_var.dims

        regridded = regridder.regrid_nd(np.asarray(data_var.values, dtype=np.float32))
        new_dims = tuple("lat" if d == row_dim else "lon" if d == col_dim else d for d in dims)

        attrs = dict(data_var.attrs)
        attrs.pop("coordinates", None)
        attrs.pop("_FillValue", None)
        attrs["grid_mapping"] = "crs"
        data_vars[name] = xr.DataArray(regridded, dims=new_dims, attrs=attrs, name=name)

        if {"lat", "lon", "depth"}.issubset(new_dims):
            ndim_rank = data_vars[name].ndim
            if primary_candidate is None or ndim_rank > data_vars[primary_candidate].ndim:
                primary_candidate = name

        print(f"  regridded {name:<14} {tuple(dims)} -> {new_dims}")

    if not data_vars:
        raise ValueError("No data variables with the curvilinear (y, x) layout were found.")

    # Derive current speed magnitude from the eastward/northward components so a
    # raster layer can show current intensity (particles handle direction).
    if "u" in data_vars and "v" in data_vars and "current_speed" not in data_vars:
        u_var = data_vars["u"]
        v_var = data_vars["v"]
        speed = np.hypot(np.asarray(u_var.values, dtype=np.float32),
                         np.asarray(v_var.values, dtype=np.float32)).astype(np.float32)
        data_vars["current_speed"] = xr.DataArray(
            speed,
            dims=u_var.dims,
            attrs={
                "long_name": "sea water current speed",
                "standard_name": "sea_water_speed",
                "units": "m s-1",
                "grid_mapping": "crs",
            },
            name="current_speed",
        )
        print(f"  derived   current_speed  {tuple(u_var.dims)} = hypot(u, v)")

    # Assemble coordinate variables.
    coords: dict[str, object] = {
        "lat": ("lat", target_lat, {
            "long_name": "latitude",
            "standard_name": "latitude",
            "units": "degrees_north",
            "axis": "Y",
        }),
        "lon": ("lon", target_lon, {
            "long_name": "longitude",
            "standard_name": "longitude",
            "units": "degrees_east",
            "axis": "X",
        }),
    }

    depth_name = infer_depth_name(source)
    if depth_name is not None:
        depth_attrs = dict(source[depth_name].attrs)
        depth_attrs.setdefault("standard_name", "depth")
        depth_attrs.setdefault("axis", "Z")
        coords["depth"] = ("depth", np.asarray(source[depth_name].values, dtype=np.float64), depth_attrs)

    time_name = infer_time_name(source)
    if time_name is not None:
        coords["time"] = ("time", np.asarray(source[time_name].values), dict(source[time_name].attrs))

    ds = xr.Dataset(data_vars=data_vars, coords=coords, attrs=dict(source.attrs))
    source.close()

    # Rename depth/time dims on data vars are already 'depth'/'time' because the
    # source dims kept their names; only y/x were renamed during regridding.
    if time_name is not None and time_name != "time":
        ds = ds.rename({time_name: "time"})

    # Longitude normalization + canonical ordering.
    ds = ds.assign_coords(lon=("lon", normalize_longitudes_1d(ds["lon"].values, lon_mode), ds["lon"].attrs))
    ds = ds.sortby("lon").sortby("lat")

    if "time" in ds.coords and ds.sizes.get("time", 0) > 0:
        ds = ds.sortby("time")

    primary_variable = variable_name or primary_candidate or next(iter(data_vars))
    if primary_variable not in ds.data_vars:
        raise KeyError(f"Variable '{primary_variable}' not found in regridded dataset.")

    ds["crs"] = build_crs_variable()

    ds.attrs.setdefault("Conventions", "CF-1.10")
    ds.attrs.setdefault("title", f"{input_path.stem} converted from NetCDF to Zarr")
    ds.attrs["source_netcdf"] = str(input_path)
    ds.attrs["primary_variable"] = primary_variable
    ds.attrs["geospatial_bounds_crs"] = "EPSG:4326"
    ds.attrs["map_projection"] = "EPSG:4326"
    ds.attrs["geospatial_lon_min"] = float(np.nanmin(ds["lon"].values))
    ds.attrs["geospatial_lon_max"] = float(np.nanmax(ds["lon"].values))
    ds.attrs["geospatial_lat_min"] = float(np.nanmin(ds["lat"].values))
    ds.attrs["geospatial_lat_max"] = float(np.nanmax(ds["lat"].values))

    if "time" in ds.coords and ds.sizes.get("time", 0) > 0:
        time_values = ds["time"].values
        ds.attrs["time_coverage_start"] = str(np.asarray(time_values[0]).astype("datetime64[ns]")).replace(" ", "T")
        ds.attrs["time_coverage_end"] = str(np.asarray(time_values[-1]).astype("datetime64[ns]")).replace(" ", "T")

    ds = encode_time_coordinate(ds)

    return ds, primary_variable


def write_zarr(ds: xr.Dataset, output_path: Path) -> None:
    if output_path.exists():
        shutil.rmtree(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    encoding = build_encoding(ds)
    try:
        ds.to_zarr(
            output_path,
            mode="w",
            consolidated=True,
            zarr_format=2,
            encoding=encoding,
            write_empty_chunks=True,
        )
    except TypeError as exc:
        raise RuntimeError(
            "This script requires xarray/zarr support for Zarr v2 output. "
            "Please install versions that support Dataset.to_zarr(..., zarr_format=2) and run again."
        ) from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert a 3D (depth) curvilinear NetCDF file to Zarr for the MapLibre page")
    parser.add_argument("--input", help=f"Path to the NetCDF file (default: {DEFAULT_INPUT}).")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help=f"Output Zarr store path (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--variable", default=None, help="Optional data variable to mark as the primary variable for the map.")
    parser.add_argument("--lon-mode", default="0_360", choices=["0_360", "-180_180"], help="Normalize longitude coordinates before writing.")
    parser.add_argument("--nx", type=int, default=None, help="Number of longitude points in the regular target grid (default: source x size).")
    parser.add_argument("--ny", type=int, default=None, help="Number of latitude points in the regular target grid (default: source y size).")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_path = resolve_input_path(args.input)
    output_path = Path(args.output).expanduser().resolve()

    ds, primary_variable = prepare_dataset(input_path, args.lon_mode, args.nx, args.ny, args.variable)
    write_zarr(ds, output_path)

    print()
    print(f"Input NetCDF   : {input_path}")
    print(f"Output Zarr    : {output_path}")
    print(f"Primary var    : {primary_variable}")
    print(f"Data variables : {', '.join(ds.data_vars)}")
    print(f"Latitude size  : {ds.sizes.get('lat', 'n/a')}")
    print(f"Longitude size : {ds.sizes.get('lon', 'n/a')}")
    if "depth" in ds.sizes:
        print(f"Depth levels   : {ds.sizes['depth']}")
    if "time" in ds.sizes:
        print(f"Time steps     : {ds.sizes['time']}")
    print("Projection     : EPSG:4326")
    print("Done.")


if __name__ == "__main__":
    main()
