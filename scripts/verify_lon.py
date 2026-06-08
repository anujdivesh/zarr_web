import zarr
root = zarr.open("public/raro_inun.zarr", mode="r")
lons = root["lon"][:]
print(f"Longitude range: {lons.min()} to {lons.max()}")