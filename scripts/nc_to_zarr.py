#!/usr/bin/env python3
"""Convert a NetCDF file (structured lat/lon grid) to a web‑friendly Zarr store.

Handles NetCDF files where the coordinate variables contain placeholder values
(e.g., projected indices) by replacing them using the global geospatial bounds.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import numpy as np
import xarray as xr

try:
    from pyproj import CRS
except Exception:  # pragma: no cover - optional dependency
    CRS = None


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_CANDIDATES = [
    WORKSPACE_ROOT / "scripts" / "latest_merged.nc",
    WORKSPACE_ROOT / "scripts" / "latest_mergec.nc",
]
DEFAULT_OUTPUT = WORKSPACE_ROOT / "public" / "zarr-data" / "latest_merged_v2.zarr"

LATITUDE_NAMES = ("lat", "latitude", "y")
LONGITUDE_NAMES = ("lon", "longitude", "x")
TIME_NAMES = ("time", "valid_time")


def normalize_text(value: object) -> str:
    return str(value).strip().lower() if value is not None else ""


def parse_coordinate_references(value: object) -> list[str]:
    if not isinstance(value, str):
        return []
    return [part for part in value.replace(",", " ").split() if part]


def looks_like_latitude_coordinate(name: str, variable: xr.DataArray) -> bool:
    standard_name = normalize_text(variable.attrs.get("standard_name"))
    units = normalize_text(variable.attrs.get("units"))
    long_name = normalize_text(variable.attrs.get("long_name"))
    normalized_name = normalize_text(name)

    return (
        normalized_name in LATITUDE_NAMES
        or standard_name in {"latitude", "projection_y_coordinate"}
        or "degrees_north" in units
        or "latitude" in long_name
        or long_name.endswith("_y")
    )


def looks_like_longitude_coordinate(name: str, variable: xr.DataArray) -> bool:
    standard_name = normalize_text(variable.attrs.get("standard_name"))
    units = normalize_text(variable.attrs.get("units"))
    long_name = normalize_text(variable.attrs.get("long_name"))
    normalized_name = normalize_text(name)

    return (
        normalized_name in LONGITUDE_NAMES
        or standard_name in {"longitude", "projection_x_coordinate"}
        or "degrees_east" in units
        or "longitude" in long_name
        or long_name.endswith("_x")
    )


def resolve_input_path(explicit_path: str | None) -> Path:
    if explicit_path:
        path = Path(explicit_path).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Input file not found: {path}")
        return path

    for candidate in DEFAULT_INPUT_CANDIDATES:
        if candidate.exists():
            return candidate

    candidates_text = "\n".join(f"- {candidate}" for candidate in DEFAULT_INPUT_CANDIDATES)
    raise FileNotFoundError(f"Could not find an input NetCDF file. Looked for:\n{candidates_text}")


def find_coordinate_name(ds: xr.Dataset, candidates: tuple[str, ...], standard_name: str) -> str | None:
    for name in candidates:
        if name in ds.coords or name in ds.variables or name in ds.dims:
            return name

    for name in list(ds.coords) + [var_name for var_name in ds.variables if var_name not in ds.coords]:
        coord = ds[name]
        if standard_name == "latitude" and looks_like_latitude_coordinate(name, coord):
            return name
        if standard_name == "longitude" and looks_like_longitude_coordinate(name, coord):
            return name

    return None


def find_spatial_coordinate_names(ds: xr.Dataset, preferred_variable_name: str | None = None) -> tuple[str | None, str | None]:
    if preferred_variable_name and preferred_variable_name in ds.variables:
        preferred_var = ds[preferred_variable_name]

        referenced_names: list[str] = []
        referenced_names.extend(parse_coordinate_references(preferred_var.attrs.get("coordinates")))

        grid_name = preferred_var.attrs.get("grid")
        if isinstance(grid_name, str) and grid_name in ds.variables:
            grid_var = ds[grid_name]
            referenced_names.extend(parse_coordinate_references(grid_var.attrs.get("face_coordinates")))

        lat_name: str | None = None
        lon_name: str | None = None
        for name in referenced_names:
            if name not in ds.variables and name not in ds.coords:
                continue
            variable = ds[name]
            if lat_name is None and looks_like_latitude_coordinate(name, variable):
                lat_name = name
            if lon_name is None and looks_like_longitude_coordinate(name, variable):
                lon_name = name

        if lat_name or lon_name:
            return lat_name, lon_name

    return (
        find_coordinate_name(ds, LATITUDE_NAMES, "latitude"),
        find_coordinate_name(ds, LONGITUDE_NAMES, "longitude"),
    )


def choose_primary_variable(ds: xr.Dataset, variable_name: str | None) -> str:
    if variable_name:
        if variable_name not in ds.data_vars:
            available = ", ".join(ds.data_vars)
            raise KeyError(f"Variable '{variable_name}' not found. Available variables: {available}")
        return variable_name

    candidates: list[str] = []
    for name, data_var in ds.data_vars.items():
        dims = set(data_var.dims)
        coordinate_refs = set(parse_coordinate_references(data_var.attrs.get("coordinates")))
        has_spatial_coordinates = any(ref in ds.variables or ref in ds.coords for ref in coordinate_refs)
        if {"lat", "lon"}.issubset(dims) or has_spatial_coordinates or len(dims) >= 2:
            candidates.append(name)

    if not candidates:
        available = ", ".join(ds.data_vars)
        raise ValueError(f"Could not find a plottable variable with lat/lon dimensions. Available: {available}")

    candidates.sort(key=lambda name: (ds[name].ndim, ds[name].size), reverse=True)
    return candidates[0]


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


def normalize_longitudes(ds: xr.Dataset, mode: str) -> xr.Dataset:
    lon = ds["lon"].astype("float64")

    if mode == "0_360":
        lon = xr.where(lon < 0, lon + 360.0, lon)
    elif mode == "-180_180":
        lon = ((lon + 180.0) % 360.0) - 180.0
    else:
        raise ValueError(f"Unsupported longitude mode: {mode}")

    ds = ds.assign_coords(lon=lon)
    if ds["lon"].ndim == 1:
        return ds.sortby("lon")
    return ds


def collapse_structured_xy_to_1d(
    x_values: np.ndarray,
    y_values: np.ndarray,
) -> tuple[np.ndarray, np.ndarray] | None:
    if x_values.ndim != 2 or y_values.ndim != 2 or x_values.shape != y_values.shape:
        return None

    if np.allclose(x_values, x_values[:1, :], equal_nan=True) and np.allclose(
        y_values, y_values[:, :1], equal_nan=True
    ):
        return np.asarray(x_values[0, :], dtype=np.float64), np.asarray(y_values[:, 0], dtype=np.float64)

    if np.allclose(x_values, x_values[:, :1], equal_nan=True) and np.allclose(
        y_values, y_values[:1, :], equal_nan=True
    ):
        return np.asarray(x_values[:, 0], dtype=np.float64), np.asarray(y_values[0, :], dtype=np.float64)

    return None


def canonicalize_spatial_coordinates(ds: xr.Dataset, lat_name: str, lon_name: str) -> xr.Dataset:
    lat_var = ds[lat_name]
    lon_var = ds[lon_name]

    if lat_var.ndim == 1 and lon_var.ndim == 1:
        lat_dim = lat_var.dims[0]
        lon_dim = lon_var.dims[0]
        ds = ds.assign_coords(
            lat=(lat_dim, np.asarray(lat_var.values, dtype=np.float64)),
            lon=(lon_dim, np.asarray(lon_var.values, dtype=np.float64)),
        )

        rename_dims: dict[str, str] = {}
        if lat_dim != "lat":
            rename_dims[lat_dim] = "lat"
        if lon_dim != "lon":
            rename_dims[lon_dim] = "lon"
        if rename_dims:
            ds = ds.swap_dims(rename_dims)

        drop_vars = [name for name in {lat_name, lon_name} if name in ds.variables and name not in {"lat", "lon"}]
        if drop_vars:
            ds = ds.drop_vars(drop_vars)
        return ds

    if lat_var.ndim == 2 and lon_var.ndim == 2 and lat_var.dims == lon_var.dims:
        row_dim, col_dim = lat_var.dims
        collapsed = collapse_structured_xy_to_1d(
            np.asarray(lon_var.values, dtype=np.float64),
            np.asarray(lat_var.values, dtype=np.float64),
        )
        if collapsed is None:
            raise ValueError(
                "Could not reduce 2D spatial coordinates to 1D axes. Only regular structured grids are supported."
            )

        lon_1d, lat_1d = collapsed
        ds = ds.assign_coords(
            lat=(row_dim, lat_1d),
            lon=(col_dim, lon_1d),
        )

        rename_dims: dict[str, str] = {}
        if row_dim != "lat":
            rename_dims[row_dim] = "lat"
        if col_dim != "lon":
            rename_dims[col_dim] = "lon"
        if rename_dims:
            ds = ds.swap_dims(rename_dims)

        drop_vars = [name for name in {lat_name, lon_name} if name in ds.variables and name not in {"lat", "lon"}]
        if drop_vars:
            ds = ds.drop_vars(drop_vars)
        return ds

    raise ValueError(
        "Unsupported coordinate layout. Expected 1D lat/lon axes or 2D structured x/y coordinate grids."
    )


def infer_time_name(ds: xr.Dataset) -> str | None:
    for name in TIME_NAMES:
        if name in ds.coords:
            return name
    return None


def format_cf_reference_time(value: np.datetime64) -> str:
    return np.datetime_as_string(value.astype("datetime64[s]"), unit="s").replace("T", " ")


def encode_time_coordinate(ds: xr.Dataset) -> xr.Dataset:
    if "time" not in ds.coords:
        return ds

    time_coord = ds["time"]
    time_values = np.asarray(time_coord.values)

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

    time_values_seconds = time_values.astype("datetime64[s]")
    reference_time = time_values_seconds[0]
    offsets = ((time_values_seconds - reference_time) / np.timedelta64(1, "h")).astype(np.int32)

    time_attrs = dict(time_coord.attrs)
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
            elif dim == "lat":
                chunks.append(min(256, dim_size))
            elif dim == "lon":
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


def fix_coordinates_from_global_bounds(ds: xr.Dataset) -> xr.Dataset:
    """
    Replace lon/lat coordinate arrays using the geospatial bounds stored in global attributes.
    This corrects files where the coordinate variables contain projected or index values.
    """
    # Required global attributes
    lon_min = ds.attrs.get("geospatial_lon_min")
    lon_max = ds.attrs.get("geospatial_lon_max")
    lat_min = ds.attrs.get("geospatial_lat_min")
    lat_max = ds.attrs.get("geospatial_lat_max")

    if lon_min is None or lon_max is None or lat_min is None or lat_max is None:
        # Attributes missing → assume coordinates are already correct.
        return ds

    try:
        lon_min = float(lon_min)
        lon_max = float(lon_max)
        lat_min = float(lat_min)
        lat_max = float(lat_max)
    except (ValueError, TypeError):
        return ds

    # Identify dimension names (they may be "lon"/"lat" or something else)
    lon_dim = next((dim for dim in ds.dims if dim in LONGITUDE_NAMES), None)
    lat_dim = next((dim for dim in ds.dims if dim in LATITUDE_NAMES), None)
    if lon_dim is None or lat_dim is None:
        # No obvious lon/lat dimensions → abort
        return ds

    nlon = ds.sizes[lon_dim]
    nlat = ds.sizes[lat_dim]

    # Create correct geographic coordinates (linear spacing)
    lon_correct = np.linspace(lon_min, lon_max, nlon)
    lat_correct = np.linspace(lat_min, lat_max, nlat)

    # Replace the coordinate variables (if they exist as variables, also update them)
    ds = ds.assign_coords({lon_dim: (lon_dim, lon_correct)})
    ds = ds.assign_coords({lat_dim: (lat_dim, lat_correct)})

    # Also replace the actual variable content for those names (if they are not coordinates)
    # This ensures that any variable named exactly "lon"/"lat" is also overwritten.
    if lon_dim in ds.variables and lon_dim != lon_dim:
        ds[lon_dim].data = lon_correct
    if lat_dim in ds.variables and lat_dim != lat_dim:
        ds[lat_dim].data = lat_correct

    print(f"Replaced coordinate '{lon_dim}' with values from {lon_min} to {lon_max} (size {nlon})")
    print(f"Replaced coordinate '{lat_dim}' with values from {lat_min} to {lat_max} (size {nlat})")

    return ds


def coordinates_look_projected(ds: xr.Dataset) -> bool:
    if "lon" not in ds.coords or "lat" not in ds.coords:
        return False

    lon = np.asarray(ds["lon"].values)
    lat = np.asarray(ds["lat"].values)
    if lon.size == 0 or lat.size == 0:
        return False

    lon_min = float(np.nanmin(lon))
    lon_max = float(np.nanmax(lon))
    lat_min = float(np.nanmin(lat))
    lat_max = float(np.nanmax(lat))

    return lon_min < -180 or lon_max > 360 or lat_min < -90 or lat_max > 90


def find_grid_mapping_variable_name(ds: xr.Dataset) -> str | None:
    for name, data_var in ds.data_vars.items():
        grid_mapping_name = data_var.attrs.get("grid_mapping")
        if isinstance(grid_mapping_name, str) and grid_mapping_name in ds.variables:
            return grid_mapping_name

    if "crs" in ds.variables:
        return "crs"

    return None


def try_parse_crs(value: object) -> str | None:
    if CRS is None or value is None:
        return None

    try:
        parsed = CRS.from_user_input(value)
    except Exception:
        return None

    return parsed.to_string()


def detect_source_crs(ds: xr.Dataset) -> str | None:
    if CRS is None:
        return None

    coords_projected = coordinates_look_projected(ds)
    grid_mapping_name = find_grid_mapping_variable_name(ds)

    if grid_mapping_name is not None:
        grid_mapping_var = ds[grid_mapping_name]
        grid_mapping_attrs = dict(grid_mapping_var.attrs)

        if grid_mapping_attrs:
            try:
                detected_from_cf = CRS.from_cf(grid_mapping_attrs)
                if not (coords_projected and detected_from_cf.is_geographic):
                    return detected_from_cf.to_string()
            except Exception:
                pass

            for key in ("spatial_ref", "crs_wkt", "esri_pe_string", "proj4", "epsg_code"):
                detected = try_parse_crs(grid_mapping_attrs.get(key))
                if detected is None:
                    continue

                parsed = CRS.from_user_input(detected)
                if coords_projected and parsed.is_geographic:
                    continue
                return detected

    if "inp" in ds.variables:
        inp_attrs = dict(ds["inp"].attrs)
        for key in ("epsg_code", "epsg"):
            raw_value = inp_attrs.get(key)
            normalized = normalize_text(raw_value)
            if normalized in {"", "nil", "epsg:nil", "0", "-"}:
                continue

            candidate = str(raw_value)
            if key == "epsg" and candidate.isdigit():
                candidate = f"EPSG:{candidate}"

            detected = try_parse_crs(candidate)
            if detected is not None:
                return detected

        utm_zone = normalize_text(inp_attrs.get("utmzone"))
        if utm_zone not in {"", "nil"}:
            zone_digits = "".join(ch for ch in utm_zone if ch.isdigit())
            zone_hemisphere = "south" if utm_zone.endswith("s") else "north"
            if zone_digits:
                epsg = 32700 + int(zone_digits) if zone_hemisphere == "south" else 32600 + int(zone_digits)
                detected = try_parse_crs(f"EPSG:{epsg}")
                if detected is not None:
                    return detected

    for key in (
        "spatial_ref",
        "crs_wkt",
        "esri_pe_string",
        "proj4",
        "epsg_code",
        "crs",
        "crs_epsg",
        "geospatial_bounds_crs",
        "map_projection",
    ):
        detected = try_parse_crs(ds.attrs.get(key))
        if detected is None:
            continue

        parsed = CRS.from_user_input(detected)
        if coords_projected and parsed.is_geographic:
            continue
        return detected

    return None


def resolve_source_crs(ds: xr.Dataset, requested_source_crs: str | None) -> str | None:
    if requested_source_crs and requested_source_crs.lower() != "auto":
        return requested_source_crs

    detected = detect_source_crs(ds)
    if detected is not None:
        print(f"Detected source CRS from NetCDF metadata: {detected}")
        return detected

    if coordinates_look_projected(ds):
        print(
            "Warning: Coordinates look projected but no usable CRS metadata was found in the NetCDF file. "
            "Pass --source-crs EPSG:XXXX to reproject explicitly."
        )

    return None


def reproject_coordinates_to_wgs84(ds: xr.Dataset, source_crs: str | None) -> xr.Dataset:
    if not source_crs or "lon" not in ds.coords or "lat" not in ds.coords:
        return ds

    if not coordinates_look_projected(ds):
        return ds

    if CRS is None:
        raise RuntimeError(
            "pyproj is required for coordinate reprojection. Install pyproj or omit --source-crs."
        )

    lon = np.asarray(ds["lon"].values, dtype=np.float64)
    lat = np.asarray(ds["lat"].values, dtype=np.float64)
    if lon.ndim != 1 or lat.ndim != 1:
        raise ValueError("Only 1D lon/lat coordinate arrays are supported for reprojection.")

    transformer = CRS.from_user_input(source_crs)
    if transformer.to_epsg() == 4326 and not coordinates_look_projected(ds):
        return ds

    from pyproj import Transformer

    projected_to_wgs84 = Transformer.from_crs(source_crs, "EPSG:4326", always_xy=True)
    mid_lat = lat[len(lat) // 2]
    reprojected_lon, _ = projected_to_wgs84.transform(lon, np.full_like(lon, mid_lat))
    _, reprojected_lat = projected_to_wgs84.transform(np.full_like(lat, lon[len(lon) // 2]), lat)

    ds = ds.assign_coords(lon=("lon", np.asarray(reprojected_lon, dtype=np.float64)))
    ds = ds.assign_coords(lat=("lat", np.asarray(reprojected_lat, dtype=np.float64)))

    print(
        "Reprojected coordinates from "
        f"{source_crs} to EPSG:4326 "
        f"(lon {float(np.nanmin(reprojected_lon)):.6f}..{float(np.nanmax(reprojected_lon)):.6f}, "
        f"lat {float(np.nanmin(reprojected_lat)):.6f}..{float(np.nanmax(reprojected_lat)):.6f})"
    )
    return ds


def prepare_dataset(
    input_path: Path,
    variable_name: str | None,
    lon_mode: str,
    source_crs: str | None,
) -> tuple[xr.Dataset, str]:
    ds = xr.open_dataset(
        input_path,
        decode_cf=True,
        decode_coords="all",
        mask_and_scale=True,
    )

    # --- Fix invalid lon/lat using global bounds ---
    ds = fix_coordinates_from_global_bounds(ds)

    # --- Standard coordinate detection and renaming ---
    lat_name, lon_name = find_spatial_coordinate_names(ds, variable_name)

    if not lat_name or not lon_name:
        raise ValueError("Could not detect latitude/longitude coordinates from the NetCDF file.")

    if lat_name not in ds.coords and lat_name in ds.variables:
        ds = ds.set_coords(lat_name)
    if lon_name not in ds.coords and lon_name in ds.variables:
        ds = ds.set_coords(lon_name)

    ds = canonicalize_spatial_coordinates(ds, lat_name, lon_name)

    effective_source_crs = resolve_source_crs(ds, source_crs)
    ds = reproject_coordinates_to_wgs84(ds, effective_source_crs)

    ds = normalize_longitudes(ds, mode=lon_mode)
    ds = ds.sortby("lat")

    time_name = infer_time_name(ds)
    if time_name and time_name != "time":
        ds = ds.rename({time_name: "time"})
        time_name = "time"
    if time_name == "time":
        ds = ds.sortby("time")

    primary_variable = choose_primary_variable(ds, variable_name)

    if "crs" not in ds.variables:
        ds["crs"] = build_crs_variable()

    for name, data_var in ds.data_vars.items():
        if {"lat", "lon"}.issubset(data_var.dims):
            data_var.attrs.setdefault("grid_mapping", "crs")
            data_var.attrs.pop("coordinates", None)

    for name in ds.variables:
        ds[name].attrs.pop("coordinates", None)

    ds.attrs.setdefault("Conventions", "CF-1.10")
    ds.attrs.setdefault("title", f"{input_path.stem} converted from NetCDF to Zarr")
    ds.attrs["source_netcdf"] = str(input_path)
    ds.attrs["primary_variable"] = primary_variable
    ds.attrs["geospatial_bounds_crs"] = "EPSG:4326"
    ds.attrs["map_projection"] = "EPSG:4326"

    if "time" in ds.coords and ds.sizes.get("time", 0) > 0:
        time_values = ds["time"].values
        start = np.asarray(time_values[0]).astype("datetime64[ns]")
        end = np.asarray(time_values[-1]).astype("datetime64[ns]")
        ds.attrs["time_coverage_start"] = str(start).replace(" ", "T")
        ds.attrs["time_coverage_end"] = str(end).replace(" ", "T")

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
            write_empty_chunks=True,   # Force writing all chunks, even those entirely filled with missing values
        )
    except TypeError as exc:
        raise RuntimeError(
            "This script requires xarray/zarr support for Zarr v2 output. "
            "Please install versions that support Dataset.to_zarr(..., zarr_format=2) and run again."
        ) from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert a NetCDF file to Zarr for the MapLibre page")
    parser.add_argument("--input", help="Path to the NetCDF file. Defaults to scripts/latest_merged.nc if present.")
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help=f"Output Zarr store path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--variable",
        default=None,
        help="Optional data variable to mark as the primary variable for the map.",
    )
    parser.add_argument(
        "--lon-mode",
        default="0_360",
        choices=["0_360", "-180_180"],
        help="Normalize longitude coordinates before writing the Zarr store.",
    )
    parser.add_argument(
        "--source-crs",
        default="auto",
        help="Optional source CRS for reprojecting invalid lon/lat coordinates to EPSG:4326. Use 'auto' to detect from NetCDF metadata.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_path = resolve_input_path(args.input)
    output_path = Path(args.output).expanduser().resolve()

    ds, primary_variable = prepare_dataset(input_path, args.variable, args.lon_mode, args.source_crs)
    write_zarr(ds, output_path)

    print(f"Input NetCDF   : {input_path}")
    print(f"Output Zarr    : {output_path}")
    print(f"Primary var    : {primary_variable}")
    print(f"Latitude size  : {ds.sizes.get('lat', 'n/a')}")
    print(f"Longitude size : {ds.sizes.get('lon', 'n/a')}")
    if "time" in ds.sizes:
        print(f"Time steps     : {ds.sizes['time']}")
    print("Projection     : EPSG:4326")
    print("Done.")


if __name__ == "__main__":
    main()