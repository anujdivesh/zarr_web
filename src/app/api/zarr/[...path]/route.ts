import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";

function guessContentType(filePath: string): string {
  const base = path.posix.basename(filePath);
  if (
    base === ".zmetadata" ||
    base === ".zgroup" ||
    base === ".zattrs" ||
    base === ".zarray" ||
    base.endsWith(".json")
  ) {
    return "application/json; charset=utf-8";
  }
  return "application/octet-stream";
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path: pathParts } = await context.params;

    const publicRoot = path.resolve(process.cwd(), "public");
    const requested = (pathParts ?? [])
      .map((p) => decodeURIComponent(p))
      .filter((p) => p.length > 0);

    // Resolve the requested path within /public and block path traversal.
    const resolved = path.resolve(publicRoot, ...requested);
    if (!resolved.startsWith(publicRoot + path.sep) && resolved !== publicRoot) {
      return new NextResponse("Not found", { status: 404 });
    }

    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return new NextResponse("Not found", { status: 404 });
    }

    const body = await fs.readFile(resolved);
    const headers = new Headers();
    headers.set("Content-Type", guessContentType(resolved));
    headers.set("Cache-Control", "public, max-age=0");

    return new NextResponse(body, { status: 200, headers });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
