// Image helpers that work in both the content script and the offscreen page.
(() => {
  const SAF = (globalThis.SAF = globalThis.SAF || {});

  SAF.blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('Could not read image'));
      r.readAsDataURL(blob);
    });

  // Decoded by hand (not fetch) so a page CSP can never get in the way.
  SAF.dataUrlToBlob = (dataUrl) => {
    const comma = dataUrl.indexOf(',');
    const meta = dataUrl.slice(5, comma);
    const type = meta.split(';')[0] || 'application/octet-stream';
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  };

  const decode = async (blob) => {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      throw new Error('This file is not an image the browser can read (HEIC/RAW are not supported).');
    }
  };

  // Re-encode as JPEG, downscaled so the long edge is at most maxEdge.
  SAF.normalizeImage = async (blob, maxEdge = 2048) => {
    const bmp = await decode(blob);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return { blob: out, width: w, height: h };
  };

  // Burn a small disclosure label ("Virtually staged") into the bottom-left corner.
  SAF.addLabel = async (blob, text) => {
    const bmp = await decode(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const size = Math.max(14, Math.round(Math.min(bmp.width, bmp.height) * 0.028));
    ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const pad = Math.round(size * 0.6);
    const tw = ctx.measureText(text).width;
    const bw = tw + pad * 2;
    const bh = size + pad * 1.4;
    const x = pad;
    const y = bmp.height - bh - pad;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, bh / 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + pad, y + bh / 2 + 1);
    bmp.close();
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  };

  // A <canvas> preview. Canvases are used instead of <img> so that the host
  // page's Content-Security-Policy (img-src) cannot block our previews.
  SAF.thumb = (blob, maxW = 320, maxH = 240) => {
    const canvas = document.createElement('canvas');
    canvas.width = maxW;
    canvas.height = Math.round(maxW * 0.66);
    canvas.className = 'thumb';
    decode(blob)
      .then((bmp) => {
        const s = Math.min(maxW / bmp.width, maxH / bmp.height, 1);
        canvas.width = Math.round(bmp.width * s);
        canvas.height = Math.round(bmp.height * s);
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close();
      })
      .catch(() => {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#6b7280';
        ctx.font = '13px system-ui';
        ctx.fillText('No preview', 12, 24);
      });
    return canvas;
  };
})();
