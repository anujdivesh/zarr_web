#!/usr/bin/env python3
"""Convert a UGRID triangular mesh NetCDF (SWAN output) to Zarr.

Keeps the mesh connectivity and the specified data variables (e.g., hs, dirm).
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import numpy as np
import xarray as xr


def sanitize_variable_encodings(ds: xr.Dataset) -> xr.Dataset:
    """Remove NetCDF encoding keys that the Zarr backend rejects."""
    for name in ds.variables:
        ds[name].encoding.pop("fill_value", None)
    return ds


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert UGRID NetCDF to Zarr")
    parser.add_argument("--input", required=True, help="Input NetCDF file")
    parser.add_argument("--output", required=True, help="Output Zarr store path")
    parser.add_argument(
        "--variables",
        default="hs,dirm",
        help="Comma‑separated list of data variables to include (default: hs,dirm)",
    )
    parser.add_argument(
        "--time-start",
        type=int,
        default=0,
        help="First time index to include (default: 0)",
    )
    parser.add_argument(
        "--time-stop",
        type=int,
        default=None,
        help="Last time index (exclusive). If omitted, include all.",
    )
    parser.add_argument(
        "--chunk-time",
        type=int,
        default=1,
        help="Chunk size along time dimension (default: 1)",
    )
    parser.add_argument(
        "--chunk-node",
        type=int,
        default=4096,
        help="Chunk size along mesh_node dimension (default: 4096)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    if not input_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")

    # Open the NetCDF file
    ds = xr.open_dataset(input_path, decode_cf=True, mask_and_scale=True)

    # Select time slice if requested
    time_start = args.time_start
    time_stop = args.time_stop if args.time_stop is not None else ds.dims["time"]
    ds = ds.isel(time=slice(time_start, time_stop))

    # Parse the list of variables to keep
    variables_to_keep = [v.strip() for v in args.variables.split(",")]

    # Always keep the mesh topology and time coordinate
    keep_vars = {
        "mesh_node_lon",
        "mesh_node_lat",
        "mesh_face_node",
        "mesh",
        "time",
    }
    keep_vars.update(variables_to_keep)

    # Check that requested variables exist
    missing = [v for v in variables_to_keep if v not in ds.data_vars]
    if missing:
        raise ValueError(f"Variables not found in input file: {missing}")

    ds = ds[list(keep_vars)]

    # Ensure the mesh variables are coordinates (for Zarr)
    ds = ds.set_coords(["mesh_node_lon", "mesh_node_lat", "mesh_face_node", "time"])
    ds = sanitize_variable_encodings(ds)

    # Set chunking for each data variable
    encoding = {
        var: {
            "chunks": (args.chunk_time, args.chunk_node),
            "dtype": "float32",
        }
        for var in variables_to_keep
    }
    # Also set encoding for coordinates
    encoding.update({
        "time": {"chunks": (args.chunk_time,)},
        "mesh_node_lon": {"chunks": (args.chunk_node,)},
        "mesh_node_lat": {"chunks": (args.chunk_node,)},
        "mesh_face_node": {
            "chunks": (args.chunk_node // 2, 3),
            "_FillValue": np.int32(-1),
        },
    })

    # Write to Zarr with consolidated metadata
    if output_path.exists():
        shutil.rmtree(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    ds.to_zarr(
        output_path,
        mode="w",
        consolidated=True,
        zarr_format=2,
        encoding=encoding,
        compute=True,
    )

    print(f"✅ Converted {input_path.name} → {output_path}")
    print(f"   Time steps : {ds.dims['time']}")
    print(f"   Mesh nodes : {ds.dims['mesh_node']}")
    print(f"   Mesh faces : {ds.dims['mesh_num_faces']}")
    print(f"   Variables  : {', '.join(variables_to_keep)}")


if __name__ == "__main__":
    main()