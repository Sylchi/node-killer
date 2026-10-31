/*
 * paint.js - rasterize the laid out box tree into an RGBA framebuffer.
 *
 * The painter walks boxes in painting order: background, border, then the
 * contents of each line box (glyphs and inline-block subtrees) followed by
 * the remaining block children. Glyphs come from FontBook's antialiased
 * coverage bitmaps; images are blitted with alpha blending.
 */

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function insideRounded(px, py, x, y, w, h, r) {
  if (r <= 0)
    return px >= x && py >= y && px < x + w && py < y + h;
  const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : px;
  const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : py;
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function blendPixel(fb, width, height, x, y, r, g, b, a, clip) {
  if (a <= 0 || x < clip.x0 || y < clip.y0 || x >= clip.x1 || y >= clip.y1)
    return;
  if (x < 0 || y < 0 || x >= width || y >= height)
    return;
  const o = (y * width + x) * 4;
  if (a >= 255) {
    fb[o] = r; fb[o + 1] = g; fb[o + 2] = b; fb[o + 3] = 255;
    return;
  }
  const inv = 255 - a;
  fb[o] = (r * a + fb[o] * inv) / 255;
  fb[o + 1] = (g * a + fb[o + 1] * inv) / 255;
  fb[o + 2] = (b * a + fb[o + 2] * inv) / 255;
  fb[o + 3] = 255;
}

function fillRect(fb, width, height, x, y, w, h, color, clip) {
  if (!color || color.a <= 0 || w <= 0 || h <= 0)
    return;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  let x1 = Math.ceil(x + w), y1 = Math.ceil(y + h);
  if (x0 < clip.x0) x0 = clip.x0;
  if (y0 < clip.y0) y0 = clip.y0;
  if (x1 > clip.x1) x1 = clip.x1;
  if (y1 > clip.y1) y1 = clip.y1;
  if (x1 > width) x1 = width;
  if (y1 > height) y1 = height;
  const a = Math.round((color.a === undefined ? 1 : color.a) * 255);
  const r = Math.round(color.r), g = Math.round(color.g), b = Math.round(color.b);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++)
      blendPixel(fb, width, height, px, py, r, g, b, a, clip);
  }
}

function fillRoundedRect(fb, width, height, x, y, w, h, radius, color, clip) {
  if (!color || color.a <= 0 || w <= 0 || h <= 0)
    return;
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r <= 0) {
    fillRect(fb, width, height, x, y, w, h, color, clip);
    return;
  }
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.ceil(x + w), y1 = Math.ceil(y + h);
  const alpha = Math.round((color.a === undefined ? 1 : color.a) * 255);
  const cr = Math.round(color.r), cg = Math.round(color.g), cb = Math.round(color.b);
  /* Sample a 2x2 grid per pixel for smooth corners. */
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      let hits = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const fx = px + (sx + 0.5) / 2;
          const fy = py + (sy + 0.5) / 2;
          if (insideRounded(fx, fy, x, y, w, h, r))
            hits++;
        }
      }
      if (hits)
        blendPixel(fb, width, height, px, py, cr, cg, cb,
                   Math.round(alpha * hits / 4), clip);
    }
  }
}

function blitImage(fb, width, height, img, dx, dy, dw, dh, clip) {
  if (!img || !img.data || dw <= 0 || dh <= 0)
    return;
  let x0 = Math.floor(dx), y0 = Math.floor(dy);
  let x1 = Math.ceil(dx + dw), y1 = Math.ceil(dy + dh);
  const startX = x0, startY = y0;
  if (x0 < clip.x0) x0 = clip.x0;
  if (y0 < clip.y0) y0 = clip.y0;
  if (x1 > clip.x1) x1 = clip.x1;
  if (y1 > clip.y1) y1 = clip.y1;
  if (x1 > width) x1 = width;
  if (y1 > height) y1 = height;
  const sw = img.width, sh = img.height;
  for (let py = y0; py < y1; py++) {
    const sy = Math.min(sh - 1, Math.floor((py - startY) * sh / dh));
    for (let px = x0; px < x1; px++) {
      const sx = Math.min(sw - 1, Math.floor((px - startX) * sw / dw));
      const so = (sy * sw + sx) * 4;
      const a = img.data[so + 3];
      if (!a)
        continue;
      blendPixel(fb, width, height, px, py,
                 img.data[so], img.data[so + 1], img.data[so + 2], a, clip);
    }
  }
}

function parseBackgroundPosition(value, boxW, boxH, imgW, imgH) {
  const parts = String(value || "0% 0%").trim().split(/\s+/);
  const one = (token, box, img) => {
    if (token === "left" || token === "top") return 0;
    if (token === "right" || token === "bottom") return box - img;
    if (token === "center") return (box - img) / 2;
    if (token && token.endsWith("%"))
      return (box - img) * parseFloat(token) / 100;
    return parseFloat(token) || 0;
  };
  const x = one(parts[0] || "0%", boxW, imgW);
  const y = one(parts[1] || "center", boxH, imgH);
  return { x, y };
}

/**
 * @param {Object} root laid out root box
 * @param {Object} ctx {fontBook, images, width, height, background}
 * @returns {Uint8Array} RGBA pixels
 */
export function paintDocument(root, ctx) {
  const width = ctx.width;
  const height = ctx.height;
  const fb = new Uint8Array(width * height * 4);
  const bg = ctx.background || { r: 255, g: 255, b: 255, a: 1 };
  for (let i = 0; i < width * height; i++) {
    fb[i * 4] = bg.r;
    fb[i * 4 + 1] = bg.g;
    fb[i * 4 + 2] = bg.b;
    fb[i * 4 + 3] = 255;
  }

  const state = { width, height, fb, ctx, shapeCache: new Map() };

  const fullClip = { x0: 0, y0: 0, x1: width, y1: height };
  const body = root.body || root;
  paintBox(body, state, fullClip);
  return fb;
}

function paintBox(box, state, clip) {
  if (box.__painted)
    return;
  box.__painted = true;
  if (box.style.visibility === "hidden")
    return;

  const fb = state.fb;
  const width = state.width;
  const height = state.height;
  const style = box.style;
  const clip2 = { ...clip };

  /* Background. */
  if (style.backgroundColor && style.backgroundColor.a > 0) {
    fillRoundedRect(fb, width, height, box.x, box.y, box.w, box.h,
                    style.borderRadius || 0, style.backgroundColor, clip2);
  }

  /* Background image. */
  if (style.backgroundImage) {
    const m = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i.exec(style.backgroundImage);
    const url = m ? (m[1] || m[2] || m[3] || "").trim() : null;
    const img = url ? state.ctx.images.get(url) : null;
    if (img) {
      const bx = box.x + borderSide(style, 3);
      const by = box.y + borderSide(style, 0);
      const bw = Math.max(0, box.w - borderSide(style, 1) - borderSide(style, 3));
      const bh = Math.max(0, box.h - borderSide(style, 0) - borderSide(style, 2));
      const pos = parseBackgroundPosition(style.backgroundPosition, bw, bh,
                                           img.width, img.height);
      const area = { x0: Math.max(clip2.x0, Math.floor(bx)),
                     y0: Math.max(clip2.y0, Math.floor(by)),
                     x1: Math.min(clip2.x1, Math.ceil(bx + bw)),
                     y1: Math.min(clip2.y1, Math.ceil(by + bh)) };
      const repeat = style.backgroundRepeat || "repeat";
      const tileW = repeat === "no-repeat" || repeat === "repeat-y" ? bw : img.width;
      const tileH = repeat === "no-repeat" || repeat === "repeat-x" ? bh : img.height;
      if (repeat === "no-repeat") {
        blitImage(fb, width, height, img, bx + pos.x, by + pos.y,
                  img.width, img.height, area);
      } else {
        const startX = bx + pos.x - Math.ceil((pos.x % tileW) / tileW) * tileW;
        const startY = by + pos.y - Math.ceil((pos.y % tileH) / tileH) * tileH;
        for (let ty = startY; ty < by + bh; ty += tileH) {
          if (ty + img.height <= by)
            continue;
          for (let tx = startX; tx < bx + bw; tx += tileW) {
            if (tx + img.width <= bx)
              continue;
            blitImage(fb, width, height, img, tx, ty,
                      img.width, img.height, area);
          }
        }
      }
    }
  }

  /* Borders. */
  const bw = [borderSide(style, 0), borderSide(style, 1),
              borderSide(style, 2), borderSide(style, 3)];
  if (bw[0] > 0)
    fillRect(fb, width, height, box.x, box.y, box.w, bw[0],
             style.border[0].color, clip2);
  if (bw[1] > 0)
    fillRect(fb, width, height, box.x + box.w - bw[1], box.y, bw[1], box.h,
             style.border[1].color, clip2);
  if (bw[2] > 0)
    fillRect(fb, width, height, box.x, box.y + box.h - bw[2], box.w, bw[2],
             style.border[2].color, clip2);
  if (bw[3] > 0)
    fillRect(fb, width, height, box.x, box.y, bw[3], box.h,
             style.border[3].color, clip2);

  /* Clip for descendants when overflow is hidden. */
  if (style.overflow === "hidden" || style.overflow === "clip") {
    clip2.x0 = Math.max(clip2.x0, Math.floor(box.contentX));
    clip2.y0 = Math.max(clip2.y0, Math.floor(box.contentY));
    clip2.x1 = Math.min(clip2.x1, Math.ceil(box.contentX + box.contentW));
    clip2.y1 = Math.min(clip2.y1, Math.ceil(box.contentY + box.contentH));
  }

  /* Line boxes: text glyphs and inline boxes in order. */
  for (const line of box.lines) {
    for (const item of line.items) {
      if (item.type === "text") {
        drawText(state, item, clip2);
      } else if (item.type === "box") {
        paintBox(item.box, state, clip2);
      }
    }
  }

  /* Replaced content and remaining block children. */
  if (box.kind === "replaced") {
    if (box.image)
      blitImage(fb, width, height, box.image, box.contentX, box.contentY,
                box.contentW, box.contentH, clip2);
  } else if (box.kind === "input") {
    paintInput(box, state, clip2);
  }

  for (const child of box.children) {
    if (child.kind === "text" || child.kind === "br")
      continue;
    if (child.__painted)
      continue;
    paintBox(child, state, clip2);
  }
}

function borderSide(style, side) {
  const b = style.border[side];
  return b && b.style !== "none" && b.style !== "hidden" ? b.width : 0;
}

function drawText(state, item, clip) {
  const style = item.style;
  const color = style.color;
  if (!color || color.a <= 0)
    return;
  const r = Math.round(color.r), g = Math.round(color.g), b = Math.round(color.b);
  const alpha = Math.round((color.a === undefined ? 1 : color.a) * 255);
  const shape = item.shape;
  const ls = item.letterSpacing || 0;
  for (let i = 0; i < shape.glyphs.length; i++) {
    const glyph = shape.glyphs[i];
    const penX = item.x + glyph.x + ls * i;
    const penY = item.baseline + glyph.y;
    let phase = penX - Math.floor(penX);
    phase = Math.round(phase * 4) / 4;
    if (phase >= 1) phase = 0;
    const bm = glyph.face.bitmap(glyph.gid, style.fontSize, phase);
    if (!bm.width || !bm.height)
      continue;
    const gx = Math.floor(penX) + bm.left;
    const gy = Math.floor(penY) + bm.top;
    for (let y = 0; y < bm.height; y++) {
      for (let x = 0; x < bm.width; x++) {
        const a = bm.alpha[y * bm.width + x];
        if (!a)
          continue;
        blendPixel(state.fb, state.width, state.height, gx + x, gy + y,
                   r, g, b, Math.round(a * alpha / 255), clip);
      }
    }
  }

  if (style.textDecoration && style.textDecoration.includes("underline")) {
    const thickness = Math.max(1, Math.round(style.fontSize / 14));
    fillRect(state.fb, state.width, state.height,
             item.x, item.baseline + Math.round(style.fontSize * 0.12),
             shape.width + ls * Math.max(0, shape.glyphs.length - 1),
             thickness, color, clip);
  }
}

function paintInput(box, state, clip) {
  const style = box.style;
  const type = box.inputType;
  if (!box.value)
    return;
  const shape = shapeInputText(state, box);
  if (!shape)
    return;
  let x = box.contentX;
  let baseline;
  if (type === "submit" || type === "button" || type === "reset") {
    x = box.contentX + (box.contentW - shape.width) / 2;
    baseline = box.contentY +
      (box.contentH - (shape.ascent + shape.descent)) / 2 + shape.ascent;
  } else {
    baseline = box.contentY +
      (box.contentH - (shape.ascent + shape.descent)) / 2 + shape.ascent;
  }
  drawText(state, {
    text: box.value, style, shape, letterSpacing: 0,
    x, baseline,
  }, clip);
}

function shapeInputText(state, box) {
  const key = "input|" + box.style.fontFamily + "|" + box.style.fontWeight +
              "|" + box.style.fontSize + "|" + box.value;
  let shape = state.shapeCache.get(key);
  if (!shape) {
    shape = state.ctx.fontBook.shape(box.value, box.style.fontFamily,
                                     box.style.fontWeight, box.style.fontStyle,
                                     box.style.fontSize);
    state.shapeCache.set(key, shape);
  }
  return shape;
}
