#!/usr/bin/env python3
"""Convert the local merged NetCDF file into a web-friendly Zarr store.

This script is intended for datasets on a regular lat/lon grid that should be
served by the Next.js app and rendered by the MapLibre page.

Default usage:
    source ../vzarr/bin/activate
    python scripts/convert_latest_merged_to_zarr.py

Optional usage:
    python scripts/convert_latest_merged_to_zarr.py \
        --input scripts/latest_merged.nc \
        --output public/zarr-data/latest_merged_v2.zarr \
        --variable sig_wav_ht
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

    for name in ds.coords:
        coord = ds.coords[name]
        coord_standard_name = str(coord.attrs.get("standard_name", "")).strip().lower()
        coord_units = str(coord.attrs.get("units", "")).strip().lower()
        coord_long_name = str(coord.attrs.get("long_name", "")).strip().lower()
        if coord_standard_name == standard_name:
            return name
        if standard_name == "latitude" and "degrees_north" in coord_units:
            return name
        if standard_name == "longitude" and "degrees_east" in coord_units:
            return name
        if standard_name in coord_long_name:
            return name

    return None


def choose_primary_variable(ds: xr.Dataset, variable_name: str | None) -> str:
    if variable_name:
        if variable_name not in ds.data_vars:
            available = ", ".join(ds.data_vars)
            raise KeyError(f"Variable '{variable_name}' not found. Available variables: {available}")
        return variable_name

    candidates: list[str] = []
    for name, data_var in ds.data_vars.items():
        dims = set(data_var.dims)
        if {"lat", "lon"}.issubset(dims):
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
    return ds.sortby("lon")


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


def prepare_dataset(input_path: Path, variable_name: str | None, lon_mode: str) -> tuple[xr.Dataset, str]:
    ds = xr.open_dataset(
        input_path,
        decode_cf=True,
        decode_coords="all",
        mask_and_scale=True,
    )

    lat_name = find_coordinate_name(ds, LATITUDE_NAMES, "latitude")
    lon_name = find_coordinate_name(ds, LONGITUDE_NAMES, "longitude")

    if not lat_name or not lon_name:
        raise ValueError("Could not detect latitude/longitude coordinates from the NetCDF file.")

    rename_map = {}
    if lat_name != "lat":
        rename_map[lat_name] = "lat"
    if lon_name != "lon":
        rename_map[lon_name] = "lon"
    ds = ds.rename(rename_map)

    if "lat" not in ds.coords and "lat" in ds.variables:
        ds = ds.set_coords("lat")
    if "lon" not in ds.coords and "lon" in ds.variables:
        ds = ds.set_coords("lon")

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
        )
    except TypeError as exc:
        raise RuntimeError(
            "This script requires xarray/zarr support for Zarr v2 output. "
            "Please install versions that support Dataset.to_zarr(..., zarr_format=2) and run again."
        ) from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert a merged NetCDF file to Zarr for the MapLibre page")
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
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_path = resolve_input_path(args.input)
    output_path = Path(args.output).expanduser().resolve()

    ds, primary_variable = prepare_dataset(input_path, args.variable, args.lon_mode)
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