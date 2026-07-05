'use strict';
// Resolume Advanced Output (ScreenSetup) XML import & export.
// Multiple screens, polygon slice masks (key points), rect orientation and flip
// are preserved as first-class data.
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./sxml'));
  } else {
    global.Resolume = factory(global.SXML);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (SXML) {
  function bboxOf(el) {
    if (!el) return null;
    const vs = SXML.childrenByTag(el, 'v');
    if (!vs.length) return null;
    const xs = vs.map((v) => parseFloat(v.attrs.x));
    const ys = vs.map((v) => parseFloat(v.attrs.y));
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  function pointsOf(el) {
    if (!el) return null;
    const vs = SXML.childrenByTag(el, 'v');
    if (vs.length < 3) return null;
    return vs.map((v) => ({ x: Math.round(parseFloat(v.attrs.x)), y: Math.round(parseFloat(v.attrs.y)) }));
  }

  function paramValue(parent, groupName, paramName) {
    const groups = SXML.findAllDeep(
      parent,
      (e) => e.tag === 'Params' && e.attrs.name === groupName
    );
    for (const g of groups) {
      const p = g.children.find(
        (c) =>
          (c.tag === 'Param' || c.tag === 'ParamRange' || c.tag === 'ParamChoice') &&
          c.attrs.name === paramName
      );
      if (p) return p.attrs.value;
    }
    return undefined;
  }

  function rnd(r) {
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  }

  function parseScreenSetup(xmlText) {
    const root = SXML.parse(xmlText);
    if (!root) throw new Error('Not valid XML');
    const doc =
      root.tag === 'ScreenSetup'
        ? root
        : SXML.findAllDeep(root, (e) => e.tag === 'ScreenSetup')[0] || root;
    const name = (root.attrs && root.attrs.name) || 'Import';

    const inputSizes = SXML.findAllDeep(doc, (e) => e.tag === 'InputSize');
    let input = null;
    if (inputSizes.length) {
      input = {
        width: parseFloat(inputSizes[0].attrs.width),
        height: parseFloat(inputSizes[0].attrs.height),
      };
    }

    const screenEls = SXML.findAllDeep(doc, (e) => e.tag === 'Screen');
    const slices = [];
    const screens = [];
    let idc = 1;
    let scc = 1;

    for (const screenEl of screenEls) {
      const scName =
        paramValue(screenEl, 'Params', 'Name') || screenEl.attrs.name || 'Output #' + scc;
      const dev = SXML.findAllDeep(
        screenEl,
        (e) => e.tag.startsWith('OutputDevice') && e.attrs.width && e.attrs.height
      )[0];
      const screen = {
        id: 'scr' + scc++,
        name: scName,
        width: dev ? Math.round(parseFloat(dev.attrs.width)) : 1920,
        height: dev ? Math.round(parseFloat(dev.attrs.height)) : 1080,
      };
      screens.push(screen);

      for (const sl of SXML.findAllDeep(screenEl, (e) => e.tag === 'Slice')) {
        const nm = paramValue(sl, 'Common', 'Name') || 'Slice ' + idc;
        const enabled = paramValue(sl, 'Common', 'Enabled') !== '0';
        const inRectEl = SXML.firstChild(sl, 'InputRect');
        const outRectEl = SXML.firstChild(sl, 'OutputRect');
        const inR = bboxOf(inRectEl);
        const outR = bboxOf(outRectEl);
        if (!inR || !outR || inR.w <= 0 || inR.h <= 0) continue;

        const inOrient = parseInt(inRectEl.attrs.orientation || '0', 10) || 0;
        const outOrient = parseInt(outRectEl.attrs.orientation || '0', 10) || 0;
        const flip = parseInt(paramValue(sl, 'Output', 'Flip') || '0', 10) || 0;

        let mask = null;
        const maskEl = SXML.firstChild(sl, 'SliceMask');
        if (maskEl) {
          const mEnabled = paramValue(maskEl, 'Input Mask', 'Enabled') !== '0';
          const shape = SXML.firstChild(maskEl, 'ShapeObject');
          // prefer the contour points (supports polygons), fall back to the Rect
          let pts = null;
          if (shape) {
            const shapeEl = SXML.firstChild(shape, 'Shape');
            const contour = shapeEl ? SXML.firstChild(shapeEl, 'Contour') : null;
            pts = contour ? pointsOf(SXML.firstChild(contour, 'points')) : null;
            if (!pts) {
              const mR = bboxOf(SXML.firstChild(shape, 'Rect'));
              if (mR && mR.w > 0 && mR.h > 0) {
                pts = [
                  { x: Math.round(mR.x), y: Math.round(mR.y) },
                  { x: Math.round(mR.x + mR.w), y: Math.round(mR.y) },
                  { x: Math.round(mR.x + mR.w), y: Math.round(mR.y + mR.h) },
                  { x: Math.round(mR.x), y: Math.round(mR.y + mR.h) },
                ];
              }
            }
          }
          if (pts) mask = { enabled: mEnabled, points: pts };
        }
        slices.push({
          id: 'imp' + idc++,
          name: nm,
          enabled,
          screenId: screen.id,
          in: rnd(inR),
          out: rnd(outR),
          inOrient,
          outOrient,
          flip,
          mask,
        });
      }
    }

    if (!screens.length) {
      screens.push({ id: 'scr1', name: 'Output #1', width: 1920, height: 1080 });
    }
    if (!input) {
      input = {
        width: Math.max(1, ...slices.map((s) => s.in.x + s.in.w)),
        height: Math.max(1, ...slices.map((s) => s.in.y + s.in.h)),
      };
    }

    return {
      name,
      input: { width: Math.round(input.width), height: Math.round(input.height) },
      screens,
      slices,
    };
  }

  function rectVerts(r, indent) {
    return [
      `${indent}<v x="${r.x}" y="${r.y}"/>`,
      `${indent}<v x="${r.x + r.w}" y="${r.y}"/>`,
      `${indent}<v x="${r.x + r.w}" y="${r.y + r.h}"/>`,
      `${indent}<v x="${r.x}" y="${r.y + r.h}"/>`,
    ].join('\n');
  }

  function bezierGrid(r, indent) {
    const lines = [];
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const x = Math.round(r.x + (i * r.w) / 3);
        const y = Math.round(r.y + (j * r.h) / 3);
        lines.push(`${indent}<v x="${x}" y="${y}"/>`);
      }
    }
    return lines.join('\n');
  }

  function maskBBoxLocal(points) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  function sliceXml(s, uidNum, L) {
    const esc = SXML.esc;
    const inOrient = s.inOrient || 0;
    const outOrient = s.outOrient || 0;
    L.push(`                    <Slice uniqueId="${uidNum}">`);
    L.push('                        <Params name="Common">');
    L.push(`                            <Param name="Name" default="Layer" value="${esc(s.name)}"/>`);
    L.push(`                            <Param name="Enabled" default="1" value="${s.enabled === false ? 0 : 1}"/>`);
    L.push('                        </Params>');
    L.push('                        <Params name="Input">');
    L.push('                            <ParamChoice name="Input Source" default="0:1" value="0:1" storeChoices="0"/>');
    L.push('                            <Param name="Input Opacity" default="1" value="1"/>');
    L.push('                            <Param name="Input Bypass/Solo" default="1" value="1"/>');
    L.push('                            <Param name="SoftEdgeEnable" default="0" value="0"/>');
    L.push('                        </Params>');
    L.push('                        <Params name="Output">');
    L.push(`                            <Param name="Flip" default="0" value="${s.flip || 0}"/>`);
    L.push('                            <ParamRange name="Brightness" default="0" value="0"><ValueRange name="defaultRange" min="-1" max="1"/></ParamRange>');
    L.push('                            <ParamRange name="Contrast" default="0" value="0"><ValueRange name="defaultRange" min="-1" max="1"/></ParamRange>');
    L.push('                            <ParamRange name="Red" default="0" value="0"><ValueRange name="defaultRange" min="-1" max="1"/></ParamRange>');
    L.push('                            <ParamRange name="Green" default="0" value="0"><ValueRange name="defaultRange" min="-1" max="1"/></ParamRange>');
    L.push('                            <ParamRange name="Blue" default="0" value="0"><ValueRange name="defaultRange" min="-1" max="1"/></ParamRange>');
    L.push('                            <Param name="Is Key" default="0" value="0"/>');
    L.push('                            <Param name="Black BG" default="0" value="0"/>');
    L.push('                            <ParamRange name="BRed" default="0" value="0"><ValueRange name="defaultRange" min="0" max="0.40000000000000002"/></ParamRange>');
    L.push('                            <ParamRange name="BGreen" default="0" value="0"><ValueRange name="defaultRange" min="0" max="0.40000000000000002"/></ParamRange>');
    L.push('                            <ParamRange name="BBlue" default="0" value="0"><ValueRange name="defaultRange" min="0" max="0.40000000000000002"/></ParamRange>');
    L.push('                        </Params>');
    L.push(`                        <InputRect orientation="${inOrient}">`);
    L.push(rectVerts(s.in, '                            '));
    L.push('                        </InputRect>');
    L.push(`                        <OutputRect orientation="${outOrient}">`);
    L.push(rectVerts(s.out, '                            '));
    L.push('                        </OutputRect>');
    L.push('                        <Warper>');
    L.push('                            <Params name="Warper"><ParamChoice name="Point Mode" default="PM_LINEAR" value="PM_LINEAR" storeChoices="0"/></Params>');
    L.push('                            <BezierWarper controlWidth="4" controlHeight="4">');
    L.push('                                <vertices>');
    L.push(bezierGrid(s.out, '                                    '));
    L.push('                                </vertices>');
    L.push('                            </BezierWarper>');
    L.push('                            <Homography>');
    L.push('                                <src>');
    L.push(rectVerts(s.out, '                                    '));
    L.push('                                </src>');
    L.push('                                <dst>');
    L.push(rectVerts(s.out, '                                    '));
    L.push('                                </dst>');
    L.push('                            </Homography>');
    L.push('                        </Warper>');
    if (s.mask && s.mask.points && s.mask.points.length >= 3) {
      const bb = maskBBoxLocal(s.mask.points);
      L.push('                        <SliceMask>');
      L.push('                            <Params name="Input Mask">');
      L.push('                                <Param name="Name" default="Mask" value="Mask"/>');
      L.push(`                                <Param name="Enabled" default="1" value="${s.mask.enabled === false ? 0 : 1}"/>`);
      L.push('                                <Param name="Invert" default="1" value="1"/>');
      L.push('                            </Params>');
      L.push('                            <ShapeObject>');
      L.push('                                <Params name="Shape">');
      L.push('                                    <ParamChoice name="Point Mode" default="PM_LINEAR" value="PM_LINEAR" storeChoices="0"/>');
      L.push('                                </Params>');
      L.push('                                <Rect orientation="0">');
      L.push(rectVerts(bb, '                                    '));
      L.push('                                </Rect>');
      L.push('                                <Shape>');
      L.push('                                    <Contour closed="1">');
      L.push('                                        <points>');
      for (const p of s.mask.points) {
        L.push(`                                            <v x="${p.x}" y="${p.y}"/>`);
      }
      L.push('                                        </points>');
      L.push(`                                        <segments>${'L'.repeat(s.mask.points.length)}</segments>`);
      L.push('                                    </Contour>');
      L.push('                                </Shape>');
      L.push('                            </ShapeObject>');
      L.push('                        </SliceMask>');
    }
    L.push('                    </Slice>');
  }

  function exportScreenSetup(project) {
    const esc = SXML.esc;
    const IW = Math.round(project.input.width);
    const IH = Math.round(project.input.height);
    const screens = project.screens && project.screens.length
      ? project.screens
      : [{ id: 'scr1', name: 'Output #1', width: (project.output || {}).width || 1920, height: (project.output || {}).height || 1080 }];

    const L = [];
    L.push('<?xml version="1.0" encoding="utf-8"?>');
    L.push(`<XmlState name="${esc(project.name || 'XtremeLED Remap Export')}">`);
    L.push('    <versionInfo name="Resolume Arena" majorVersion="5" minorVersion="0" microVersion="0" revision="00000"/>');
    L.push('    <ScreenSetup name="ScreenSetup">');
    L.push('        <Params name="ScreenSetupParams"/>');
    L.push('        <sizing>');
    L.push('            <inputs>');
    L.push(`                <InputSize name="0:1" width="${IW}" height="${IH}"/>`);
    L.push('            </inputs>');
    L.push('        </sizing>');
    L.push('        <screens>');

    let uidNum = 2150;
    screens.forEach((screen, si) => {
      const OW = Math.round(screen.width);
      const OH = Math.round(screen.height);
      L.push(`            <Screen name="${esc(screen.name)}" uniqueId="${14150 + si}">`);
      L.push('                <Params name="Params">');
      L.push(`                    <Param name="Name" default="" value="${esc(screen.name)}"/>`);
      L.push('                    <Param name="Enabled" default="1" value="1"/>');
      L.push('                    <Param name="Hidden" default="0" value="0"/>');
      L.push('                </Params>');
      L.push('                <Params name="Output">');
      L.push('                    <ParamRange name="Opacity" default="1" value="1"><ValueRange name="defaultRange" min="0" max="1"/></ParamRange>');
      L.push('                    <ParamRange name="Brightness" default="0" value="0"><ValueRange name="defaultRange" min="-1" max="1"/></ParamRange>');
      L.push('                    <ParamRange name="Contrast" default="0" value="0"><ValueRange name="defaultRange" min="-1" max="1"/></ParamRange>');
      L.push('                    <ParamRange name="Red" default="0" value="0"><ValueRange name="defaultRange" min="-1" max="1"/></ParamRange>');
      L.push('                    <ParamRange name="Green" default="0" value="0"><ValueRange name="defaultRange" min="-1" max="1"/></ParamRange>');
      L.push('                    <ParamRange name="Blue" default="0" value="0"><ValueRange name="defaultRange" min="-1" max="1"/></ParamRange>');
      L.push('                </Params>');
      L.push('                <layers>');
      const scSlices = project.slices.filter(
        (s) => (s.screenId || screens[0].id) === screen.id
      );
      scSlices.forEach((s) => {
        sliceXml(s, uidNum, L);
        uidNum += 2000;
      });
      L.push('                </layers>');
      L.push('                <OutputDevice>');
      L.push(`                    <OutputDeviceVirtual name="Virtual" deviceId="Virtual" idHash="0" width="${OW}" height="${OH}">`);
      L.push('                        <Params name="Params">');
      L.push(`                            <ParamRange name="Width" default="1920" value="${OW}"><ValueRange name="defaultRange" min="1" max="32768"/></ParamRange>`);
      L.push(`                            <ParamRange name="Height" default="1080" value="${OH}"><ValueRange name="defaultRange" min="1" max="32768"/></ParamRange>`);
      L.push('                        </Params>');
      L.push('                    </OutputDeviceVirtual>');
      L.push('                </OutputDevice>');
      L.push('            </Screen>');
    });

    L.push('        </screens>');
    L.push('        <SoftEdging>');
    L.push('            <Params name="Soft Edge">');
    L.push('                <ParamRange name="Gamma Red" default="2" value="2"><ValueRange name="defaultRange" min="1" max="3"/></ParamRange>');
    L.push('                <ParamRange name="Gamma Green" default="2" value="2"><ValueRange name="defaultRange" min="1" max="3"/></ParamRange>');
    L.push('                <ParamRange name="Gamma Blue" default="2" value="2"><ValueRange name="defaultRange" min="1" max="3"/></ParamRange>');
    L.push('                <ParamRange name="Gamma" default="1" value="1"><ValueRange name="defaultRange" min="0" max="1"/></ParamRange>');
    L.push('                <ParamRange name="Luminance" default="0.5" value="0.5"><ValueRange name="defaultRange" min="0" max="1"/></ParamRange>');
    L.push('                <ParamRange name="Power" default="2" value="2"><ValueRange name="defaultRange" min="0.10000000000000001" max="7"/></ParamRange>');
    L.push('            </Params>');
    L.push('        </SoftEdging>');
    L.push('    </ScreenSetup>');
    L.push('</XmlState>');
    return L.join('\n') + '\n';
  }

  return { parseScreenSetup, exportScreenSetup };
});
