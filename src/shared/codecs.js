'use strict';
// Export codec matrix — shared between the renderer UI and the ffmpeg pipeline.
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Codecs = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // alpha: which alpha modes the codec supports ('none' is always available)
  // depths: allowed bit depths; bitrate: whether a target bitrate applies
  const CODECS = [
    { id: 'prores_proxy', label: 'ProRes 422 Proxy', ext: 'mov', alpha: [], depths: [10], group: 'ProRes' },
    { id: 'prores_lt', label: 'ProRes 422 LT', ext: 'mov', alpha: [], depths: [10], group: 'ProRes' },
    { id: 'prores_422', label: 'ProRes 422', ext: 'mov', alpha: [], depths: [10], group: 'ProRes' },
    { id: 'prores_hq', label: 'ProRes 422 HQ', ext: 'mov', alpha: [], depths: [10], group: 'ProRes' },
    { id: 'prores_4444', label: 'ProRes 4444', ext: 'mov', alpha: ['straight', 'only'], depths: [10], group: 'ProRes' },
    { id: 'dxv', label: 'DXV3 Normal Quality', ext: 'mov', alpha: [], depths: [8], group: 'DXV' },
    { id: 'dxv_hq', label: 'DXV3 High Quality (HAP Q)', ext: 'mov', alpha: [], depths: [8], group: 'DXV', needsHap: true, note: 'Encoded as HAP Q — the same DXT5-YCoCg compression as DXV3 HQ, and Resolume plays it natively.' },
    { id: 'hap', label: 'HAP Standard', ext: 'mov', alpha: ['straight'], depths: [8], group: 'HAP' },
    { id: 'hap_q', label: 'HAP Q', ext: 'mov', alpha: [], depths: [8], group: 'HAP' },
    { id: 'hevc', label: 'HEVC / H.265', ext: 'mp4', alpha: [], depths: [8, 10, 12], bitrate: true, group: 'Delivery' },
    { id: 'h264', label: 'H.264 / AVC', ext: 'mp4', alpha: [], depths: [8], bitrate: true, group: 'Delivery' },
    { id: 'png', label: 'PNG still', ext: 'png', alpha: ['straight', 'only'], depths: [8, 16], still: true, group: 'Image' },
    { id: 'png_seq', label: 'PNG sequence', ext: 'png', alpha: ['straight', 'only'], depths: [8, 16], sequence: true, group: 'Image' },
    { id: 'wav', label: 'WAV (audio extract)', ext: 'wav', alpha: [], depths: [16, 24, 32], audioOnly: true, group: 'Audio' },
  ];

  function byId(id) {
    return CODECS.find((c) => c.id === id) || null;
  }

  // Map a probed source (from probeMedia) to the closest export settings
  function matchSource(probe) {
    const out = { codec: 'prores_hq', depth: 10, alpha: 'none', bitrateMbps: null, note: '' };
    if (!probe || !probe.videoCodec) {
      out.note = 'Unknown source codec — using ProRes 422 HQ';
      return out;
    }
    const vc = probe.videoCodec.toLowerCase();
    const variant = (probe.proresVariant || '').toLowerCase();
    if (vc === 'prores') {
      out.codec =
        { apco: 'prores_proxy', apcs: 'prores_lt', apcn: 'prores_422', apch: 'prores_hq', ap4h: 'prores_4444', ap4x: 'prores_4444' }[variant] || 'prores_hq';
      if (out.codec === 'prores_4444' && /a$/.test(probe.pixFmt || '') === false && /yuva/.test(probe.pixFmt || '')) out.alpha = 'straight';
    } else if (vc === 'hevc') {
      out.codec = 'hevc';
      out.depth = /p10/.test(probe.pixFmt || '') ? 10 : /p12/.test(probe.pixFmt || '') ? 12 : 8;
      if (probe.bitrateKbps) out.bitrateMbps = Math.round(probe.bitrateKbps / 100) / 10;
    } else if (vc === 'h264') {
      out.codec = 'h264';
      if (probe.bitrateKbps) out.bitrateMbps = Math.round(probe.bitrateKbps / 100) / 10;
    } else if (vc === 'dxv') {
      out.codec = 'dxv';
    } else if (vc === 'hap') {
      out.codec = 'hap';
    } else if (vc === 'png' || vc === 'mjpeg' || vc === 'tiff') {
      out.codec = 'png';
      out.depth = 8;
    } else {
      out.note = `Source codec "${probe.videoCodec}" has no direct match — using ProRes 422 HQ`;
    }
    if (!out.note) out.note = `Matched source: ${byId(out.codec).label}${out.bitrateMbps ? ` @ ${out.bitrateMbps} Mbps` : ''}`;
    return out;
  }

  // Codecs that have a VideoToolbox (GPU) encoder variant
  function gpuCapable(codecId) {
    return ['prores_proxy', 'prores_lt', 'prores_422', 'prores_hq', 'prores_4444', 'hevc', 'h264'].includes(codecId);
  }

  // Colour tags on every YUV delivery codec, so a player reads the matrix instead of guessing
  const BT709_TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];

  function writesBt709(codecId) {
    return ['prores_proxy', 'prores_lt', 'prores_422', 'prores_hq', 'prores_4444', 'hevc', 'h264'].includes(codecId);
  }

  // ffmpeg encoder args for a codec + options {alpha, depth, bitrateMbps, fps, gpu}
  function encoderArgs(codecId, opt) {
    const alpha = opt.alpha || 'none';
    if (opt.gpu && gpuCapable(codecId)) {
      switch (codecId) {
        case 'prores_proxy':
        case 'prores_lt':
        case 'prores_422':
        case 'prores_hq': {
          const profile = { prores_proxy: 'proxy', prores_lt: 'lt', prores_422: 'standard', prores_hq: 'hq' }[codecId];
          return ['-c:v', 'prores_videotoolbox', '-profile:v', profile, ...BT709_TAGS];
        }
        case 'prores_4444':
          return alpha === 'straight'
            ? ['-c:v', 'prores_videotoolbox', '-profile:v', '4444', '-pix_fmt', 'bgra', '-alpha_quality', '0.9', ...BT709_TAGS]
            : ['-c:v', 'prores_videotoolbox', '-profile:v', '4444', ...BT709_TAGS];
        case 'hevc': {
          const args = ['-c:v', 'hevc_videotoolbox', '-b:v', `${opt.bitrateMbps || 25}M`, '-tag:v', 'hvc1'];
          if ((opt.depth || 8) >= 10) args.push('-profile:v', 'main10', '-pix_fmt', 'p010le');
          return [...args, ...BT709_TAGS];
        }
        case 'h264':
          return ['-c:v', 'h264_videotoolbox', '-b:v', `${opt.bitrateMbps || 20}M`, ...BT709_TAGS];
      }
    }
    switch (codecId) {
      case 'prores_proxy':
      case 'prores_lt':
      case 'prores_422':
      case 'prores_hq': {
        const profile = { prores_proxy: '0', prores_lt: '1', prores_422: '2', prores_hq: '3' }[codecId];
        return ['-c:v', 'prores_ks', '-profile:v', profile, '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', ...BT709_TAGS];
      }
      case 'prores_4444':
        return ['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0',
          '-pix_fmt', alpha === 'straight' ? 'yuva444p10le' : 'yuv444p10le', ...BT709_TAGS];
      case 'dxv':
        return ['-c:v', 'dxv', '-pix_fmt', 'rgba'];
      case 'hap':
        return ['-c:v', 'hap', '-format', alpha === 'straight' ? 'hap_alpha' : 'hap'];
      case 'hap_q':
      case 'dxv_hq': // DXV3 HQ is DXT5-YCoCg — delivered as HAP Q (same compression)
        return ['-c:v', 'hap', '-format', 'hap_q'];
      case 'hevc': {
        const pix = { 8: 'yuv420p', 10: 'yuv420p10le', 12: 'yuv420p12le' }[opt.depth || 8] || 'yuv420p';
        const rate = opt.bitrateMbps
          ? ['-b:v', `${opt.bitrateMbps}M`, '-maxrate', `${Math.ceil(opt.bitrateMbps * 1.4)}M`, '-bufsize', `${Math.ceil(opt.bitrateMbps * 2)}M`]
          : ['-crf', '20'];
        return ['-c:v', 'libx265', '-preset', 'medium', ...rate, '-pix_fmt', pix, '-tag:v', 'hvc1', ...BT709_TAGS];
      }
      case 'h264': {
        const rate = opt.bitrateMbps
          ? ['-b:v', `${opt.bitrateMbps}M`, '-maxrate', `${Math.ceil(opt.bitrateMbps * 1.4)}M`, '-bufsize', `${Math.ceil(opt.bitrateMbps * 2)}M`]
          : ['-crf', '18'];
        return ['-c:v', 'libx264', '-preset', 'medium', ...rate, '-pix_fmt', 'yuv420p', ...BT709_TAGS];
      }
      case 'png':
      case 'png_seq': {
        const sixteen = (opt.depth || 8) > 8;
        if (alpha === 'straight') return ['-pix_fmt', sixteen ? 'rgba64be' : 'rgba'];
        if (alpha === 'only') return ['-pix_fmt', sixteen ? 'gray16be' : 'gray'];
        return ['-pix_fmt', sixteen ? 'rgb48be' : 'rgb24'];
      }
      case 'wav': {
        const pcm = { 16: 'pcm_s16le', 24: 'pcm_s24le', 32: 'pcm_s32le' }[opt.depth || 16] || 'pcm_s16le';
        return ['-c:a', pcm];
      }
      default:
        throw new Error(`Codec "${codecId}" is not supported for encoding`);
    }
  }

  // Output size constraints. modW/modH: the encoder (or its chroma layout) needs multiples of
  // this. strict: the encoder refuses other sizes, so padding needs the user's OK first.
  // ProRes 4444, DXV and PNG take any size, so they stay exact (no black row or column).
  function sizeRule(codecId, opt) {
    if (['hap', 'hap_q', 'dxv_hq'].includes(codecId)) return { modW: 4, modH: 4, strict: true };
    // VideoToolbox's size limits can't be verified here, so stay on the safe side when GPU is on
    if (opt && opt.gpu && gpuCapable(codecId)) return { modW: 2, modH: 2, strict: false };
    if (['h264', 'hevc'].includes(codecId)) return { modW: 2, modH: 2, strict: false }; // 4:2:0
    if (['prores_proxy', 'prores_lt', 'prores_422', 'prores_hq'].includes(codecId)) return { modW: 2, modH: 1, strict: false }; // 4:2:2
    return { modW: 1, modH: 1, strict: false };
  }

  // The size a codec will really write for a requested canvas (padding goes right and bottom)
  function fitOutputSize(codecId, width, height, opt) {
    const rule = sizeRule(codecId, opt);
    const reqW = Math.max(1, Math.round(width));
    const reqH = Math.max(1, Math.round(height));
    const w = Math.ceil(reqW / rule.modW) * rule.modW;
    const h = Math.ceil(reqH / rule.modH) * rule.modH;
    return { width: w, height: h, reqW, reqH, padded: w !== reqW || h !== reqH, rule };
  }

  // Plain-text problem for a size the encoder refuses, or null when the size is fine
  function sizeProblem(codecId, width, height, opt) {
    const fit = fitOutputSize(codecId, width, height, opt);
    if (!fit.rule.strict || !fit.padded) return null;
    const def = byId(codecId);
    const which = fit.width !== fit.reqW && fit.height !== fit.reqH ? 'width and height' : fit.width !== fit.reqW ? 'width' : 'height';
    return {
      codec: def ? def.label : codecId,
      reqW: fit.reqW,
      reqH: fit.reqH,
      width: fit.width,
      height: fit.height,
      message: `${def ? def.label : codecId} can't make ${fit.reqW}×${fit.reqH}: ${which} must be divisible by ${fit.rule.modW}`,
    };
  }

  // ---- pixel pipeline ----

  // Depth, chroma layout and alpha of an ffmpeg pixel format name, or null when it is not known.
  // hsub/vsub are 1 when the chroma is halved horizontally/vertically.
  function parsePixFmt(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    const yuv = (depth, chroma, alpha) => ({
      name: n, family: 'yuv', depth, chroma, alpha: !!alpha,
      hsub: chroma === '444' || chroma === '440' ? 0 : 1,
      vsub: chroma === '420' || chroma === '440' || chroma === '410' ? 1 : 0,
    });
    const rgb = (depth, alpha) => ({ name: n, family: 'rgb', depth, chroma: 'rgb', alpha: !!alpha, hsub: 0, vsub: 0 });
    let m = n.match(/^yuv(j|a)?(4\d\d)p(\d*)/);
    if (m) return yuv(m[3] ? parseInt(m[3], 10) : 8, m[2], m[1] === 'a');
    if (/^nv(12|21)$/.test(n)) return yuv(8, '420');
    if (n === 'nv16') return yuv(8, '422');
    if (/^nv(24|42)$/.test(n)) return yuv(8, '444');
    m = n.match(/^p([024])(10|12|16)/);
    if (m) return yuv(parseInt(m[2], 10), { 0: '420', 2: '422', 4: '444' }[m[1]]);
    if (/^(yuyv|uyvy|yvyu)422/.test(n)) return yuv(8, '422');
    m = n.match(/^y2(10|12)/);
    if (m) return yuv(parseInt(m[1], 10), '422');
    if (n === 'v210') return yuv(10, '422');
    if (n === 'v410' || n.startsWith('xv30')) return yuv(10, '444');
    if (n.startsWith('xv36')) return yuv(12, '444');
    if (n === 'ayuv' || n === 'vuya' || n === 'vuyx') return yuv(8, '444', n !== 'vuyx');
    m = n.match(/^gbr(a)?p(\d*)/);
    if (m) return rgb(m[2] ? parseInt(m[2], 10) : 8, !!m[1]);
    m = n.match(/^gray(\d*)/);
    if (m) return rgb(m[1] ? parseInt(m[1], 10) : 8, false);
    m = n.match(/^ya(8|16)/);
    if (m) return rgb(parseInt(m[1], 10), true);
    if (n === 'pal8') return rgb(8, true);
    m = n.match(/^x2(?:rgb|bgr)(10)/);
    if (m) return rgb(10, false);
    m = n.match(/^(rgba|bgra|argb|abgr|rgb0|bgr0|0rgb|0bgr|rgb|bgr)(\d*)/);
    if (m) {
      const bits = m[2] ? parseInt(m[2], 10) : 0;
      // the number in rgb24/rgb48/rgba64 counts the bits of the whole pixel
      return rgb(bits >= 48 ? 16 : 8, /a/.test(m[1]));
    }
    return null;
  }

  // Frame rate as ffmpeg should read it. ffmpeg only prints 23.98, so the NTSC rates are
  // restored to their exact 1000/1001 value (a rounded rate adds or drops frames).
  function exactRate(fps) {
    const v = Number(fps);
    if (!(v > 0)) return '25';
    if (Number.isInteger(v)) return String(v);
    const whole = Math.round(v * 1.001);
    if (Math.abs(whole / 1.001 - v) < 0.006) return `${whole * 1000}/1001`;
    return String(v);
  }

  const WORK_FORMATS = {
    '420-8': { overlay: 'yuv420', pix: 'yuv420p', alphaPix: 'yuva420p', maskPix: 'yuva420p', hsub: 1, vsub: 1, label: '8-bit 4:2:0' },
    '422-8': { overlay: 'yuv422', pix: 'yuv422p', alphaPix: 'yuva422p', maskPix: 'yuva422p', hsub: 1, vsub: 0, label: '8-bit 4:2:2' },
    '444-8': { overlay: 'yuv444', pix: 'yuv444p', alphaPix: 'yuva444p', maskPix: 'yuva444p', hsub: 0, vsub: 0, label: '8-bit 4:4:4' },
    '420-10': { overlay: 'yuv420p10', pix: 'yuv420p10le', alphaPix: 'yuva420p10le', maskPix: 'yuva420p', hsub: 1, vsub: 1, label: '10-bit 4:2:0' },
    '422-10': { overlay: 'yuv422p10', pix: 'yuv422p10le', alphaPix: 'yuva422p10le', maskPix: 'yuva422p', hsub: 1, vsub: 0, label: '10-bit 4:2:2' },
    '444-10': { overlay: 'yuv444p10', pix: 'yuv444p10le', alphaPix: 'yuva444p10le', maskPix: 'yuva444p', hsub: 0, vsub: 0, label: '10-bit 4:4:4' },
    rgb: { overlay: 'gbrp', pix: 'gbrp', alphaPix: 'gbrap', maskPix: 'gbrap', hsub: 0, vsub: 0, label: '8-bit RGB' },
  };

  // How one export runs through the filter graph: the format the graph stays in, and which
  // slices need help to stay exact. Used by buildArgs and by the Pixel check card, so the
  // card always tells what the export really does.
  // slices: Geometry.effectiveSlices entries; probe: probeMedia result (may be null);
  // options: {alpha: true for the alpha pipeline, transform}
  function pixelPlan(slices, probe, options) {
    const o = options || {};
    const src = parsePixFmt(probe && probe.pixFmt);
    const inputOdd = (fmt, s) => (fmt.hsub && s.crop.x % 2 !== 0) || (fmt.vsub && s.crop.y % 2 !== 0);
    const placedOdd = (fmt, s) => (fmt.hsub && s.place.x % 2 !== 0) || (fmt.vsub && s.place.y % 2 !== 0);

    let key;
    let reason = null;
    let limited = false; // something of the source does not fit through the pipeline
    if (o.alpha) {
      // Always 8-bit RGBA: ffmpeg's 10-bit overlay on a canvas with alpha gets the colour of
      // every semi-transparent pixel wrong, so a deeper source is limited here
      key = 'rgb';
      if (!src) {
        reason = 'source format unknown';
        limited = true;
      } else if (src.depth > 8) {
        reason = `alpha export, source is ${src.depth}-bit`;
        limited = true;
      } else if (src.family === 'yuv') reason = 'alpha export';
    } else if (!src) {
      key = '444-10'; // nothing is known, so keep everything the source could hold
      reason = 'source format unknown';
      limited = true;
    } else if (src.family === 'rgb') {
      key = src.depth > 8 ? '444-10' : 'rgb';
      if (src.depth > 8) {
        reason = `the pipeline has no ${src.depth}-bit RGB`;
        limited = true;
      }
    } else {
      const depthKey = src.depth > 8 ? '10' : '8';
      const chromaOk = ['420', '422', '444'].includes(src.chroma);
      key = `${chromaOk ? src.chroma : '444'}-${depthKey}`;
      if (!chromaOk) reason = `source is ${src.chroma}`;
      else if (src.depth > 10) {
        reason = `source is ${src.depth}-bit`;
        limited = true;
      }
    }

    // A slice placed on an odd output pixel needs the whole graph in 4:4:4, otherwise its
    // chroma lands one pixel off. The encoder still subsamples correctly afterwards.
    if (src && src.family === 'yuv' && key !== '444-8' && key !== '444-10' && slices.some((s) => placedOdd(WORK_FORMATS[key], s))) {
      key = `444-${src.depth > 8 ? '10' : '8'}`;
      reason = `odd placement, source is ${src.chroma}`;
    }

    const work = WORK_FORMATS[key];
    const oddCrops = slices.filter((s) => inputOdd(work, s)).length;
    const oddPlaced = slices.filter((s) => (s.place.x % 2 !== 0 || s.place.y % 2 !== 0)).length;
    const oddAny = slices.filter((s) => s.crop.x % 2 !== 0 || s.crop.y % 2 !== 0 || s.crop.w % 2 !== 0 || s.crop.h % 2 !== 0 || s.place.x % 2 !== 0 || s.place.y % 2 !== 0).length;

    const t = o.transform;
    const colorAdjusted = !!t && (!!t.brightness || !!t.contrast || (t.saturation != null && t.saturation !== 1));

    const hasAlpha = !!o.alpha || !!(src && src.alpha);
    const w444 = WORK_FORMATS[`444-${work.overlay.endsWith('p10') ? '10' : '8'}`];
    return {
      source: src,
      work,
      overlay: work.overlay,
      basePix: o.alpha ? work.alphaPix : work.pix, // the canvas slices are placed on
      srcPix: hasAlpha ? work.alphaPix : work.pix, // the source before it is split per slice
      maskPix: work.maskPix,
      crop444: hasAlpha ? w444.alphaPix : w444.pix, // for slices starting on an odd input pixel
      needs444: (s) => inputOdd(work, s),
      oddCrops,
      oddPlaced,
      oddAny,
      reason,
      limited,
      // the eq filter only works in 8-bit, so a colour adjustment lowers a 10-bit graph
      eightBitAdjust: colorAdjusted && key.endsWith('-10'),
      matchesSource: !!src && !reason,
    };
  }

  // The rows of the Pixel check card. Each row: {key, value, ok}. ok is false when something
  // is limited or unknown, so the card never shows a green check for it.
  function pixelCheckRows(plan, codecId, fps, isImage) {
    const def = byId(codecId);
    const rows = [];
    let proc = plan.work.label;
    if (plan.matchesSource) proc += ' (matches source)';
    else if (plan.reason) proc += ` (${plan.reason})`;
    let procOk = !plan.limited;
    if (plan.eightBitAdjust) {
      proc = `${plan.work.label}, 8-bit during color adjust`;
      procOk = false;
    }
    rows.push({ key: 'Processing', value: proc, ok: procOk });
    rows.push({
      key: 'Odd slices',
      value: plan.oddAny ? `${plan.oddAny} cropped exactly` : 'none in this mapping',
      ok: true,
    });
    if (def && def.still && !def.sequence) {
      rows.push({ key: 'Frame rate', value: 'still image', ok: true });
    } else {
      const rate = exactRate(fps);
      rows.push({ key: 'Frame rate', value: rate.includes('/') ? `${rate} (exact)` : `${rate}${isImage ? ' (set below)' : ''}`, ok: true });
    }
    rows.push({ key: 'Color tags', value: def && writesBt709(def.id) ? 'BT.709' : 'not used (RGB output)', ok: true });
    return rows;
  }

  // What the chosen codec itself does to the pixels after the pipeline
  function codecFidelityNote(codecId) {
    if (codecId === 'png' || codecId === 'png_seq') return 'PNG is lossless: nothing is lost beyond the chosen bit depth.';
    if (['dxv', 'dxv_hq', 'hap', 'hap_q'].includes(codecId)) return 'This codec is compressed block by block, so small differences remain.';
    if (codecId === 'prores_4444') return 'ProRes 4444 keeps full chroma, but it is still a lossy codec.';
    if (codecId === 'wav') return '';
    const def = byId(codecId);
    return def && def.group === 'ProRes' ? 'ProRes 422 halves the chroma horizontally and is a lossy codec.' : 'This codec halves the chroma and is lossy.';
  }

  // What the export bar shows when a batch has ended
  function batchOutcome(okCount, total, cancelled, warned) {
    const failed = Math.max(0, total - okCount);
    if (cancelled) return { state: 'cancelled', text: `Cancelled: ${okCount} of ${total} exported` };
    if (okCount <= 0) return { state: 'fail', text: `0 of ${total} exported` };
    if (failed === 0 && warned > 0) return { state: 'partial', text: total === 1 ? 'Exported with a warning' : `All ${total} exported, ${warned} with a warning` };
    if (failed === 0) return { state: 'ok', text: total === 1 ? 'Exported' : `All ${total} exported` };
    return { state: 'partial', text: `${okCount} of ${total} exported, ${failed} failed` };
  }

  return { CODECS, byId, matchSource, encoderArgs, gpuCapable, writesBt709, sizeRule, fitOutputSize, sizeProblem, parsePixFmt, exactRate, pixelPlan, pixelCheckRows, codecFidelityNote, batchOutcome };
});
