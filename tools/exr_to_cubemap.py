import argparse
import math
from pathlib import Path

import Imath
import numpy as np
import OpenEXR
from PIL import Image


FACE_ORDER = ["px", "nx", "py", "ny", "pz", "nz"]


def read_exr_rgb(path: Path) -> np.ndarray:
    exr = OpenEXR.InputFile(str(path))
    header = exr.header()
    dw = header["dataWindow"]
    width = dw.max.x - dw.min.x + 1
    height = dw.max.y - dw.min.y + 1

    pixel_type = Imath.PixelType(Imath.PixelType.FLOAT)
    r = np.frombuffer(exr.channel("R", pixel_type), dtype=np.float32).reshape(height, width)
    g = np.frombuffer(exr.channel("G", pixel_type), dtype=np.float32).reshape(height, width)
    b = np.frombuffer(exr.channel("B", pixel_type), dtype=np.float32).reshape(height, width)
    exr.close()
    return np.stack([r, g, b], axis=-1)


def direction_for_face(face: str, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    if face == "px":
        d = np.stack([np.ones_like(u), -v, -u], axis=-1)
    elif face == "nx":
        d = np.stack([-np.ones_like(u), -v, u], axis=-1)
    elif face == "py":
        d = np.stack([u, np.ones_like(u), v], axis=-1)
    elif face == "ny":
        d = np.stack([u, -np.ones_like(u), -v], axis=-1)
    elif face == "pz":
        d = np.stack([u, -v, np.ones_like(u)], axis=-1)
    elif face == "nz":
        d = np.stack([-u, -v, -np.ones_like(u)], axis=-1)
    else:
        raise ValueError(f"Unsupported face {face}")

    n = np.linalg.norm(d, axis=-1, keepdims=True)
    return d / np.maximum(n, 1e-8)


def bilinear_sample_equirect(img: np.ndarray, uv: np.ndarray) -> np.ndarray:
    h, w, _ = img.shape
    x = uv[..., 0] * (w - 1)
    y = uv[..., 1] * (h - 1)

    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    x1 = (x0 + 1) % w
    y1 = np.clip(y0 + 1, 0, h - 1)

    x0 = np.mod(x0, w)
    y0 = np.clip(y0, 0, h - 1)

    wx = x - x0
    wy = y - y0

    c00 = img[y0, x0]
    c10 = img[y0, x1]
    c01 = img[y1, x0]
    c11 = img[y1, x1]

    c0 = c00 * (1.0 - wx)[..., None] + c10 * wx[..., None]
    c1 = c01 * (1.0 - wx)[..., None] + c11 * wx[..., None]
    return c0 * (1.0 - wy)[..., None] + c1 * wy[..., None]


def dir_to_uv(d: np.ndarray) -> np.ndarray:
    x = d[..., 0]
    y = np.clip(d[..., 1], -1.0, 1.0)
    z = d[..., 2]

    theta = np.arctan2(z, x)
    phi = np.arcsin(y)

    u = 0.5 + theta / (2.0 * math.pi)
    v = 0.5 - phi / math.pi
    return np.stack([u, v], axis=-1)


def tonemap_and_encode_8bit(hdr: np.ndarray, exposure: float, gamma: float) -> np.ndarray:
    x = np.maximum(hdr, 0.0) * exposure
    x = x / (1.0 + x)
    x = np.power(np.clip(x, 0.0, 1.0), 1.0 / gamma)
    return np.clip(x * 255.0 + 0.5, 0, 255).astype(np.uint8)


def write_face_png(path: Path, rgb_u8: np.ndarray) -> None:
    Image.fromarray(rgb_u8).save(path)


def convert_equirect_to_cubemap(input_exr: Path, output_dir: Path, size: int, exposure: float, gamma: float) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    hdr = read_exr_rgb(input_exr)

    g = np.linspace(-1.0, 1.0, size, dtype=np.float32)
    uu, vv = np.meshgrid(g, g)

    for face in FACE_ORDER:
        d = direction_for_face(face, uu, vv)
        uv = dir_to_uv(d)
        sampled = bilinear_sample_equirect(hdr, uv)
        rgb_u8 = tonemap_and_encode_8bit(sampled, exposure=exposure, gamma=gamma)
        write_face_png(output_dir / f"{face}.png", rgb_u8)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert equirectangular EXR to cubemap PNG faces")
    parser.add_argument("input", type=Path, help="Input EXR (equirectangular)")
    parser.add_argument("output", type=Path, help="Output directory for px/nx/py/ny/pz/nz PNG faces")
    parser.add_argument("--size", type=int, default=1024, help="Face resolution in pixels")
    parser.add_argument("--exposure", type=float, default=1.0, help="Exposure multiplier before tonemapping")
    parser.add_argument("--gamma", type=float, default=2.2, help="Output gamma")
    args = parser.parse_args()

    convert_equirect_to_cubemap(
        input_exr=args.input,
        output_dir=args.output,
        size=args.size,
        exposure=args.exposure,
        gamma=args.gamma,
    )

    print(f"Wrote cubemap faces to: {args.output}")
