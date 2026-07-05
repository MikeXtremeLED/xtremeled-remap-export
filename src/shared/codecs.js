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
    { id: 'dxv_hq', label: 'DXV3 High Quality', ext: 'mov', alpha: [], depths: [8], group: 'DXV', unsupported: 'ffmpeg has no DXV HQ encoder (DXT5) — use Normal Quality or ProRes' },
    { id: 'hap', label: 'HAP Standard', ext: 'mov', alpha: ['straight'], depths: [8], group: 'HAP' },
    { id: 'hap_q', label: 'HAP Q', ext: 'mov', alpha: [], depths: [8], group: 'HAP' },
    { id: 'notchlc', label: 'Notch LC', ext: 'mov', alpha: [], depths: [10], group: 'Other', unsupported: 'ffmpeg can decode but not encode Notch LC — use HAP Q or ProRes' },
    { id: 'hevc', label: 'HEVC / H.265', ext: 'mp4', alpha: [], depths: [8, 10, 12], bitrate: true, group: 'Delivery' },
    { id: 'h264', label: 'H.264 / AVC', ext: 'mp4', alpha: [], depths: [8], bitrate: true, group: 'Delivery' },
    { id: 'png', label: 'PNG still', ext: 'png', alpha: ['straight', 'only'], depths: [8, 16], still: true, group: 'Image' },
    { id: 'png_seq', label: 'PNG sequence', ext: 'png', alpha: ['straight', 'only'], depths: [8, 16], sequence: true, group: 'Image' },
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

  // ffmpeg encoder args for a codec + options {alpha, depth, bitrateMbps, fps}
  function encoderArgs(codecId, opt) {
    const alpha = opt.alpha || 'none';
    switch (codecId) {
      case 'prores_proxy':
      case 'prores_lt':
      case 'prores_422':
      case 'prores_hq': {
        const profile = { prores_proxy: '0', prores_lt: '1', prores_422: '2', prores_hq: '3' }[codecId];
        return ['-c:v', 'prores_ks', '-profile:v', profile, '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le',
          '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
      }
      case 'prores_4444':
        return ['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0',
          '-pix_fmt', alpha === 'straight' ? 'yuva444p10le' : 'yuv444p10le'];
      case 'dxv':
        return ['-c:v', 'dxv', '-pix_fmt', 'rgba'];
      case 'hap':
        return ['-c:v', 'hap', '-format', alpha === 'straight' ? 'hap_alpha' : 'hap'];
      case 'hap_q':
        return ['-c:v', 'hap', '-format', 'hap_q'];
      case 'hevc': {
        const pix = { 8: 'yuv420p', 10: 'yuv420p10le', 12: 'yuv420p12le' }[opt.depth || 8] || 'yuv420p';
        const rate = opt.bitrateMbps
          ? ['-b:v', `${opt.bitrateMbps}M`, '-maxrate', `${Math.ceil(opt.bitrateMbps * 1.4)}M`, '-bufsize', `${Math.ceil(opt.bitrateMbps * 2)}M`]
          : ['-crf', '20'];
        return ['-c:v', 'libx265', '-preset', 'medium', ...rate, '-pix_fmt', pix, '-tag:v', 'hvc1'];
      }
      case 'h264': {
        const rate = opt.bitrateMbps
          ? ['-b:v', `${opt.bitrateMbps}M`, '-maxrate', `${Math.ceil(opt.bitrateMbps * 1.4)}M`, '-bufsize', `${Math.ceil(opt.bitrateMbps * 2)}M`]
          : ['-crf', '18'];
        return ['-c:v', 'libx264', '-preset', 'medium', ...rate, '-pix_fmt', 'yuv420p'];
      }
      case 'png':
      case 'png_seq': {
        const sixteen = (opt.depth || 8) > 8;
        if (alpha === 'straight') return ['-pix_fmt', sixteen ? 'rgba64be' : 'rgba'];
        if (alpha === 'only') return ['-pix_fmt', sixteen ? 'gray16be' : 'gray'];
        return ['-pix_fmt', sixteen ? 'rgb48be' : 'rgb24'];
      }
      default:
        throw new Error(`Codec "${codecId}" is not supported for encoding`);
    }
  }

  return { CODECS, byId, matchSource, encoderArgs };
});
