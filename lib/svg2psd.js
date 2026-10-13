/*!
 * svg2psd.js — SVG → 편집 가능한 PSD 변환 (브라우저 전용, 외부 사이트 불필요)
 *
 *   <g>                                   → PSD 폴더
 *   rect / circle / ellipse / line /
 *   polyline / polygon / path             → 셰이프 레이어 (벡터 마스크 + 칠/획)
 *   text / tspan                          → 텍스트 레이어
 *   image, use, 그라디언트·클립·필터 등    → 이미지 레이어 (픽셀)
 *
 * 같은 폴더의 ag-psd.js(MIT)를 필요할 때 불러온다.
 *
 * 사용법:
 *   await SVGtoPSD.download(svgStringOrElement, '파일명.psd', options);
 *   const arrayBuffer = await SVGtoPSD.convert(svgStringOrElement, options);
 *
 * options:
 *   width, height      PSD 크기 (기본: SVG width/height 또는 viewBox)
 *   layerName(el)      레이어 이름을 정하는 함수 (없으면 data-name, <title>, id 순)
 *   groupName(el)      폴더 이름을 정하는 함수 (없으면 data-name, 앞 주석, id 순)
 *   defaultFont        알 수 없는 글꼴일 때 쓸 PostScript 이름 (기본 AppleSDGothicNeo)
 *   simplify           직선 도형의 점 단순화 허용 오차(px, 기본 0.25, 0이면 끔)
 */
(function () {
    'use strict';

    const scriptSrc = document.currentScript && document.currentScript.src;
    const AG_PSD_URL = scriptSrc ? new URL('ag-psd.js', scriptSrc).href : 'lib/ag-psd.js';
    let agPsdPromise = null;

    function loadAgPsd() {
        if (window.agPsd) return Promise.resolve(window.agPsd);
        if (!agPsdPromise) {
            agPsdPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = AG_PSD_URL;
                script.onload = () => window.agPsd ? resolve(window.agPsd) : reject(new Error('ag-psd 로드 실패'));
                script.onerror = () => { agPsdPromise = null; reject(new Error('ag-psd 로드 실패')); };
                document.head.appendChild(script);
            });
        }
        return agPsdPromise;
    }

    // ---------- 색상 ----------
    const colorCtx = document.createElement('canvas').getContext('2d');
    function parseColor(str) {
        if (!str || str === 'none' || str === 'transparent') return null;
        colorCtx.fillStyle = '#000000';
        colorCtx.fillStyle = str;
        const v = colorCtx.fillStyle;
        if (v[0] === '#') {
            return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), a: 1 };
        }
        const m = v.match(/[\d.]+/g);
        return { r: +m[0], g: +m[1], b: +m[2], a: m[3] !== undefined ? +m[3] : 1 };
    }
    const rgb = c => ({ r: c.r, g: c.g, b: c.b });
    const css = c => `rgb(${c.r},${c.g},${c.b})`;

    // ---------- 패스 ----------
    // SVG 원호(A) → 3차 베지어 곡선들 [c1x, c1y, c2x, c2y, x, y]
    function arcToBeziers(x1, y1, rx, ry, angleDeg, largeArc, sweep, x2, y2) {
        if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]];
        rx = Math.abs(rx); ry = Math.abs(ry);
        const phi = angleDeg * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
        const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
        const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
        const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
        const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
        const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
        const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
        const cxp = coef * rx * y1p / ry, cyp = -coef * ry * x1p / rx;
        const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
        const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
        const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
        let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
        if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
        if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
        const segs = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2) - 1e-9));
        const delta = dTheta / segs, t = 4 / 3 * Math.tan(delta / 4);
        const pt = th => [cx + rx * Math.cos(th) * cos - ry * Math.sin(th) * sin, cy + rx * Math.cos(th) * sin + ry * Math.sin(th) * cos];
        const der = th => [-rx * Math.sin(th) * cos - ry * Math.cos(th) * sin, -rx * Math.sin(th) * sin + ry * Math.cos(th) * cos];
        const out = [];
        for (let i = 0; i < segs; i++) {
            const a = theta1 + i * delta, b = a + delta;
            const p0 = pt(a), p3 = i === segs - 1 ? [x2, y2] : pt(b), d0 = der(a), d3 = der(b);
            out.push([p0[0] + t * d0[0], p0[1] + t * d0[1], p3[0] - t * d3[0], p3[1] - t * d3[1], p3[0], p3[1]]);
        }
        return out;
    }

    // SVG path d → [{ closed, knots: [{ x, y, ix, iy, ox, oy }] }]  (M L H V C S Q T A Z, 절대/상대)
    function parsePath(d) {
        const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
        const subpaths = [];
        let sp = null, cx = 0, cy = 0, sx = 0, sy = 0, cmd = '', prevCmd = '', i = 0;
        let lastCtrlX = 0, lastCtrlY = 0; // S/T 반사용
        const num = () => parseFloat(tokens[i++]);
        const ensure = () => { if (!sp) { sp = { closed: false, knots: [{ x: cx, y: cy, ix: cx, iy: cy, ox: cx, oy: cy }] }; subpaths.push(sp); } };
        const addKnot = (x, y) => { ensure(); sp.knots.push({ x, y, ix: x, iy: y, ox: x, oy: y }); cx = x; cy = y; };
        const addCurve = (c1x, c1y, c2x, c2y, x, y) => {
            ensure();
            const last = sp.knots[sp.knots.length - 1];
            last.ox = c1x; last.oy = c1y;
            sp.knots.push({ x, y, ix: c2x, iy: c2y, ox: x, oy: y });
            cx = x; cy = y;
        };
        const addQuad = (qx, qy, x, y) => addCurve(cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y);
        while (i < tokens.length) {
            if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
            else if (!cmd) { i++; continue; }
            const rel = cmd === cmd.toLowerCase();
            const ox = rel ? cx : 0, oy = rel ? cy : 0;
            const C = cmd.toUpperCase();
            switch (C) {
                case 'M': {
                    const x = num() + ox, y = num() + oy;
                    sp = { closed: false, knots: [] };
                    subpaths.push(sp);
                    sp.knots.push({ x, y, ix: x, iy: y, ox: x, oy: y });
                    cx = sx = x; cy = sy = y;
                    cmd = rel ? 'l' : 'L';
                    break;
                }
                case 'L': addKnot(num() + ox, num() + oy); break;
                case 'H': addKnot(num() + ox, cy); break;
                case 'V': addKnot(cx, num() + oy); break;
                case 'C': {
                    const c1x = num() + ox, c1y = num() + oy, c2x = num() + ox, c2y = num() + oy;
                    addCurve(c1x, c1y, c2x, c2y, num() + ox, num() + oy);
                    lastCtrlX = c2x; lastCtrlY = c2y;
                    break;
                }
                case 'S': {
                    const refl = /[CS]/i.test(prevCmd);
                    const c1x = refl ? 2 * cx - lastCtrlX : cx, c1y = refl ? 2 * cy - lastCtrlY : cy;
                    const c2x = num() + ox, c2y = num() + oy;
                    addCurve(c1x, c1y, c2x, c2y, num() + ox, num() + oy);
                    lastCtrlX = c2x; lastCtrlY = c2y;
                    break;
                }
                case 'Q': {
                    const qx = num() + ox, qy = num() + oy;
                    addQuad(qx, qy, num() + ox, num() + oy);
                    lastCtrlX = qx; lastCtrlY = qy;
                    break;
                }
                case 'T': {
                    const refl = /[QT]/i.test(prevCmd);
                    const qx = refl ? 2 * cx - lastCtrlX : cx, qy = refl ? 2 * cy - lastCtrlY : cy;
                    addQuad(qx, qy, num() + ox, num() + oy);
                    lastCtrlX = qx; lastCtrlY = qy;
                    break;
                }
                case 'A': {
                    const rx = num(), ry = num(), rot = num(), large = !!num(), sweep = !!num();
                    const x = num() + ox, y = num() + oy;
                    arcToBeziers(cx, cy, rx, ry, rot, large, sweep, x, y).forEach(c => addCurve(...c));
                    break;
                }
                case 'Z': {
                    if (sp) {
                        sp.closed = true;
                        const first = sp.knots[0], last = sp.knots[sp.knots.length - 1];
                        if (sp.knots.length > 1 && Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01) {
                            first.ix = last.ix; first.iy = last.iy;
                            sp.knots.pop();
                        }
                    }
                    sp = null; // 다음 그리기 명령은 시작점에서 새 서브패스
                    cx = sx; cy = sy;
                    break;
                }
                default: i++;
            }
            prevCmd = C;
        }
        return subpaths.filter(s => s.knots.length > 1);
    }

    function ellipseSubpath(cx, cy, rx, ry) {
        const k = 0.5522847498;
        return {
            closed: true,
            knots: [
                { x: cx + rx, y: cy, ix: cx + rx, iy: cy - ry * k, ox: cx + rx, oy: cy + ry * k },
                { x: cx, y: cy + ry, ix: cx + rx * k, iy: cy + ry, ox: cx - rx * k, oy: cy + ry },
                { x: cx - rx, y: cy, ix: cx - rx, iy: cy + ry * k, ox: cx - rx, oy: cy - ry * k },
                { x: cx, y: cy - ry, ix: cx - rx * k, iy: cy - ry, ox: cx + rx * k, oy: cy - ry },
            ],
        };
    }

    function polySubpath(points, closed) {
        return { closed, knots: points.map(([x, y]) => ({ x, y, ix: x, iy: y, ox: x, oy: y })) };
    }

    // 직선으로만 이루어진 서브패스에서 tolerance(px) 이하로 벗어나는 점 제거 (Ramer–Douglas–Peucker)
    // 지도처럼 점이 매우 많은 도형의 PSD 용량을 크게 줄인다. 곡선이 섞인 서브패스는 그대로 둔다.
    function simplifySubpath(sp, tolerance) {
        const k = sp.knots;
        if (!(tolerance > 0) || k.length < 4) return sp;
        const isCorner = p => p.ix === p.x && p.iy === p.y && p.ox === p.x && p.oy === p.y;
        if (!k.every(isCorner)) return sp;
        const pts = sp.closed ? k.concat([k[0]]) : k;
        const keep = new Uint8Array(pts.length);
        keep[0] = keep[pts.length - 1] = 1;
        const tol2 = tolerance * tolerance;
        const stack = [[0, pts.length - 1]];
        while (stack.length) {
            const [a, b] = stack.pop();
            const A = pts[a], B = pts[b];
            const dx = B.x - A.x, dy = B.y - A.y, len2 = dx * dx + dy * dy;
            let maxD = -1, idx = -1;
            for (let i = a + 1; i < b; i++) {
                const P = pts[i];
                let d2;
                if (len2 === 0) d2 = (P.x - A.x) ** 2 + (P.y - A.y) ** 2;
                else {
                    const cr = dx * (P.y - A.y) - dy * (P.x - A.x);
                    d2 = cr * cr / len2;
                }
                if (d2 > maxD) { maxD = d2; idx = i; }
            }
            if (idx >= 0 && maxD > tol2) {
                keep[idx] = 1;
                stack.push([a, idx], [idx, b]);
            }
        }
        let out = pts.filter((_, i) => keep[i]);
        if (sp.closed) out = out.slice(0, -1);
        return out.length >= (sp.closed ? 3 : 2) ? { closed: sp.closed, knots: out } : sp;
    }

    function transformSubpaths(subpaths, m) {
        const tx = (x, y) => m.a * x + m.c * y + m.e, ty = (x, y) => m.b * x + m.d * y + m.f;
        return subpaths.map(sp => ({
            closed: sp.closed,
            knots: sp.knots.map(k => ({
                x: tx(k.x, k.y), y: ty(k.x, k.y),
                ix: tx(k.ix, k.iy), iy: ty(k.ix, k.iy),
                ox: tx(k.ox, k.oy), oy: ty(k.ox, k.oy),
            })),
        }));
    }

    // 요소의 로컬 좌표계 기준 서브패스
    function geometryOf(el) {
        const len = a => a.baseVal.value;
        switch (el.localName) {
            case 'rect': {
                const x = len(el.x), y = len(el.y), w = len(el.width), h = len(el.height);
                if (w <= 0 || h <= 0) return null;
                let rx = el.rx.baseVal.value, ry = el.ry.baseVal.value;
                const hasRx = el.hasAttribute('rx'), hasRy = el.hasAttribute('ry');
                if (hasRx && !hasRy) ry = rx;
                if (hasRy && !hasRx) rx = ry;
                rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
                if (rx > 0 && ry > 0) {
                    return parsePath(`M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}` +
                        `A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}` +
                        `V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`);
                }
                return [polySubpath([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true)];
            }
            case 'circle': {
                const r = len(el.r);
                return r > 0 ? [ellipseSubpath(len(el.cx), len(el.cy), r, r)] : null;
            }
            case 'ellipse': {
                const rx = len(el.rx), ry = len(el.ry);
                return rx > 0 && ry > 0 ? [ellipseSubpath(len(el.cx), len(el.cy), rx, ry)] : null;
            }
            case 'line':
                return [polySubpath([[len(el.x1), len(el.y1)], [len(el.x2), len(el.y2)]], false)];
            case 'polyline':
            case 'polygon': {
                const pts = [];
                for (let i = 0; i < el.points.numberOfItems; i++) {
                    const p = el.points.getItem(i);
                    pts.push([p.x, p.y]);
                }
                return pts.length > 1 ? [polySubpath(pts, el.localName === 'polygon')] : null;
            }
            case 'path': {
                const sp = parsePath(el.getAttribute('d') || '');
                return sp.length ? sp : null;
            }
        }
        return null;
    }

    // ---------- 글꼴 ----------
    const FONT_MAP = [
        [/^apple ?sd ?gothic ?neo|^applesdgothicneo/i, 'AppleSDGothicNeo-Regular', 'AppleSDGothicNeo-Bold'],
        [/^noto ?sans ?kr|^notosanskr/i, 'NotoSansKR-Regular', 'NotoSansKR-Bold'],
        [/^noto ?sans ?cjk ?kr/i, 'NotoSansCJKkr-Regular', 'NotoSansCJKkr-Bold'],
        [/^pretendard/i, 'Pretendard-Regular', 'Pretendard-Bold'],
        [/^spoqa ?han ?sans/i, 'SpoqaHanSansNeo-Regular', 'SpoqaHanSansNeo-Bold'],
        [/^malgun ?gothic|^맑은 ?고딕/i, 'MalgunGothic', 'MalgunGothicBold'],
        [/^nanum ?gothic|^나눔고딕/i, 'NanumGothic', 'NanumGothicBold'],
        [/^nanum ?square|^나눔스퀘어/i, 'NanumSquareR', 'NanumSquareB'],
        [/^arial$/i, 'ArialMT', 'Arial-BoldMT'],
        [/^helvetica ?neue/i, 'HelveticaNeue', 'HelveticaNeue-Bold'],
        [/^helvetica$/i, 'Helvetica', 'Helvetica-Bold'],
        [/^times ?new ?roman/i, 'TimesNewRomanPSMT', 'TimesNewRomanPS-BoldMT'],
    ];
    function fontName(family, bold, fallback) {
        const families = family.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        for (const f of families) {
            for (const [re, regular, boldName] of FONT_MAP) {
                if (re.test(f)) return bold ? boldName : regular;
            }
        }
        // 이미 PostScript 이름처럼 보이면 그대로 사용 (예: Roboto-Regular)
        const ps = families.find(f => /^[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(f));
        if (ps) return bold ? ps.replace(/-(Regular|Medium|Light|Book)$/i, '-Bold') : ps;
        return fallback(bold);
    }

    // ---------- 렌더링 ----------
    function renderToCanvas(svgEl, w, h) {
        const text = new XMLSerializer().serializeToString(svgEl);
        const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                URL.revokeObjectURL(url);
                resolve(canvas);
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG 렌더링 실패')); };
            img.src = url;
        });
    }

    function isEmpty(canvas) {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
        return true;
    }

    const SKIP_TAGS = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'script', 'clipPath', 'mask', 'marker',
        'pattern', 'linearGradient', 'radialGradient', 'symbol', 'filter']);
    const SHAPE_TAGS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);
    const GROUP_TAGS = new Set(['g', 'a', 'switch']);
    const SHAPE_NAMES = { rect: '사각형', circle: '원', ellipse: '타원', line: '선', polyline: '선', polygon: '다각형', path: '패스' };

    async function convert(svgInput, options = {}) {
        const agPsd = await loadAgPsd();
        const svgText = typeof svgInput === 'string' ? svgInput : new XMLSerializer().serializeToString(svgInput);
        const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        if (parsed.querySelector('parsererror')) throw new Error('SVG 파싱 실패');
        const root = document.importNode(parsed.documentElement, true);

        // 문서 크기
        const vbAttr = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
        const hasVB = vbAttr.length === 4 && vbAttr.every(n => !isNaN(n)) && vbAttr[2] > 0 && vbAttr[3] > 0;
        const attrPx = name => {
            const v = root.getAttribute(name);
            return v && !/%$/.test(v.trim()) ? parseFloat(v) : NaN;
        };
        const W = Math.round(options.width || attrPx('width') || (hasVB ? vbAttr[2] : 0) || 1920);
        const H = Math.round(options.height || attrPx('height') || (hasVB ? vbAttr[3] : 0) || 1080);
        const vb = hasVB ? vbAttr : [0, 0, W, H];
        root.setAttribute('width', W);
        root.setAttribute('height', H);
        if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

        // 페이지 CSS의 영향을 받지 않도록 Shadow DOM 안에 붙여 측정
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:-200000px;top:0;pointer-events:none;';
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });
        root.style.display = 'block';
        shadow.appendChild(root);

        try {
            const rootRect = root.getBoundingClientRect();
            const kx = W / (rootRect.width || W), ky = H / (rootRect.height || H);
            const sharedDefs = [...root.querySelectorAll('defs, style')];

            const docRect = (el, pad) => {
                const r = el.getBoundingClientRect();
                const L = Math.max(0, Math.floor((r.left - rootRect.left) * kx - pad));
                const T = Math.max(0, Math.floor((r.top - rootRect.top) * ky - pad));
                const R = Math.min(W, Math.ceil((r.right - rootRect.left) * kx + pad));
                const B = Math.min(H, Math.ceil((r.bottom - rootRect.top) * ky + pad));
                return R > L && B > T ? { L, T, R, B } : null;
            };

            // el 하나만 (조상 변환은 유지) 잘라서 픽셀로 렌더링
            //   neutral: true 이면 조상/자신의 불투명도는 빼고 그린다 (레이어 불투명도로 따로 지정)
            //   override: 대상 요소에 덧붙일 인라인 스타일
            const renderPixels = async (el, pad, neutral, override) => {
                const rect = docRect(el, pad);
                if (!rect) return null;
                const w = rect.R - rect.L, h = rect.B - rect.T;
                const svg = root.cloneNode(false);
                svg.removeAttribute('style');
                svg.setAttribute('width', w);
                svg.setAttribute('height', h);
                svg.setAttribute('viewBox', [
                    vb[0] + rect.L * vb[2] / W, vb[1] + rect.T * vb[3] / H, w * vb[2] / W, h * vb[3] / H,
                ].join(' '));
                svg.setAttribute('preserveAspectRatio', 'none');
                sharedDefs.forEach(d => svg.appendChild(d.cloneNode(true)));
                let node = el.cloneNode(true);
                if (neutral || override) {
                    node.setAttribute('style', (node.getAttribute('style') || '') + ';' + (neutral ? 'opacity:1;' : '') + (override || ''));
                }
                for (let p = el.parentNode; p && p !== root; p = p.parentNode) {
                    const shallow = p.cloneNode(false);
                    if (neutral) shallow.setAttribute('style', (shallow.getAttribute('style') || '') + ';opacity:1');
                    shallow.appendChild(node);
                    node = shallow;
                }
                svg.appendChild(node);
                const canvas = await renderToCanvas(svg, w, h);
                return isEmpty(canvas) ? null : { canvas, left: rect.L, top: rect.T };
            };

            const opacityOf = el => {
                let o = 1;
                for (let e = el; e && e !== root.parentNode; e = e.parentNode) {
                    if (e.nodeType === 1) o *= parseFloat(getComputedStyle(e).opacity) || 0;
                }
                return o;
            };
            // 클립·마스크·필터가 걸려 있으면 벡터로 정확히 옮길 수 없으므로 픽셀로 처리
            const hasEffects = el => {
                for (let e = el; e && e !== root.parentNode; e = e.parentNode) {
                    if (e.nodeType !== 1) continue;
                    const cs = getComputedStyle(e);
                    if ((cs.clipPath && cs.clipPath !== 'none') || (cs.mask && cs.mask !== 'none') || (cs.filter && cs.filter !== 'none')) return true;
                    if (e.hasAttribute('clip-path') || e.hasAttribute('mask') || e.hasAttribute('filter')) return true;
                }
                return false;
            };

            const commentBefore = el => {
                let prev = el.previousSibling;
                while (prev && prev.nodeType === 3 && !prev.textContent.trim()) prev = prev.previousSibling;
                return prev && prev.nodeType === 8 ? prev.textContent.trim() : '';
            };
            const titleOf = el => {
                const t = [...el.children].find(c => c.localName === 'title');
                return t ? t.textContent.trim() : '';
            };
            const layerName = (el, fallback) =>
                (options.layerName && options.layerName(el)) || el.getAttribute('data-name') || titleOf(el) ||
                el.getAttribute('aria-label') || el.getAttribute('id') || fallback;
            const groupName = el =>
                (options.groupName && options.groupName(el)) || el.getAttribute('data-name') || commentBefore(el) ||
                titleOf(el) || el.getAttribute('id') || '그룹';

            const defaultFont = bold => options.defaultFont
                ? (typeof options.defaultFont === 'function' ? options.defaultFont(bold) : options.defaultFont)
                : (bold ? 'AppleSDGothicNeo-Bold' : 'AppleSDGothicNeo-Regular');

            const rasterLayer = async (el, fallbackName) => {
                const pixels = await renderPixels(el, 4, false);
                return pixels ? Object.assign({ name: layerName(el, fallbackName) }, pixels) : null;
            };

            // fill="url(#grad)" 이 단순한 linearGradient 이면 포토샵 그라디언트 칠로 변환 (아니면 null)
            const gradientFill = (el, paint, m) => {
                const id = (paint.match(/^url\(\s*["']?#([^"')]+)["']?\s*\)/) || [])[1];
                let grad = id && root.querySelector('#' + CSS.escape(id));
                if (!grad || grad.localName !== 'linearGradient') return null;
                if (grad.getAttribute('gradientUnits') === 'userSpaceOnUse' || grad.hasAttribute('gradientTransform')) return null;
                let stopsEl = grad;
                for (let i = 0; i < 5 && !stopsEl.querySelector('stop'); i++) {
                    const href = (stopsEl.getAttribute('href') || stopsEl.getAttribute('xlink:href') || '').replace(/^#/, '');
                    stopsEl = href && root.querySelector('#' + CSS.escape(href));
                    if (!stopsEl) return null;
                }
                const frac = (v, def) => {
                    if (v === null || v === '') return def;
                    return /%$/.test(v.trim()) ? parseFloat(v) / 100 : parseFloat(v);
                };
                const colorStops = [], opacityStops = [];
                for (const stop of stopsEl.querySelectorAll('stop')) {
                    const scs = getComputedStyle(stop);
                    const c = parseColor(scs.stopColor) || { r: 0, g: 0, b: 0, a: 1 };
                    const location = Math.min(1, Math.max(0, frac(stop.getAttribute('offset'), 0)));
                    colorStops.push({ color: rgb(c), location, midpoint: 0.5 });
                    opacityStops.push({ opacity: c.a * (parseFloat(scs.stopOpacity) || 0), location, midpoint: 0.5 });
                }
                if (!colorStops.length) return null;
                const x1 = frac(grad.getAttribute('x1'), 0), y1 = frac(grad.getAttribute('y1'), 0);
                const x2 = frac(grad.getAttribute('x2'), 1), y2 = frac(grad.getAttribute('y2'), 0);
                const bb = el.getBBox();
                const lx = (x2 - x1) * bb.width, ly = (y2 - y1) * bb.height;
                const dx = m.a * lx + m.c * ly, dy = m.b * lx + m.d * ly;
                const len = Math.hypot(dx, dy);
                if (!len) return null;
                // 포토샵 선형 그라디언트(레이어에 맞춤)는 레이어 경계를 그 방향으로 가로지른다
                const bw = Math.hypot(m.a * bb.width, m.b * bb.width), bh = Math.hypot(m.c * bb.height, m.d * bb.height);
                const span = Math.abs(dx / len) * bw + Math.abs(dy / len) * bh;
                return {
                    type: 'solid', name: 'Custom', style: 'linear', align: true,
                    angle: -Math.atan2(dy, dx) * 180 / Math.PI,
                    scale: span ? len / span : 1,
                    colorStops, opacityStops,
                };
            };

            const shapeLayer = async (el) => {
                const cs = getComputedStyle(el);
                const isPaint = v => /^url\(/.test(v);
                if (isPaint(cs.stroke) || hasEffects(el)) return rasterLayer(el, SHAPE_NAMES[el.localName]);
                const local = geometryOf(el);
                if (!local) return null;
                const m = el.getCTM();
                if (!m) return null;
                let gradient = null;
                if (isPaint(cs.fill) && el.localName !== 'line') {
                    gradient = gradientFill(el, cs.fill, m);
                    if (!gradient) return rasterLayer(el, SHAPE_NAMES[el.localName]);
                }
                const tolerance = options.simplify === undefined ? 0.25 : options.simplify;
                const subpaths = transformSubpaths(local, m).map(sp => simplifySubpath(sp, tolerance));
                const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;

                const canFill = el.localName !== 'line';
                let fill = gradient ? { r: 0, g: 0, b: 0, a: 1 } : canFill ? parseColor(cs.fill) : null;
                let stroke = parseColor(cs.stroke);
                const strokeWidth = parseFloat(cs.strokeWidth) || 0;
                if (stroke && strokeWidth <= 0) stroke = null;
                if (fill) fill.a *= parseFloat(cs.fillOpacity);
                if (stroke) stroke.a *= parseFloat(cs.strokeOpacity);
                if (fill && fill.a <= 0) fill = null;
                if (stroke && stroke.a <= 0) stroke = null;
                if (!fill && !stroke) return null;

                const opacity = opacityOf(el);
                const evenOdd = cs.fillRule === 'evenodd';
                const layer = {
                    name: layerName(el, SHAPE_NAMES[el.localName]),
                    opacity: opacity * (fill ? fill.a : stroke.a),
                    vectorMask: {
                        paths: subpaths.map((sp, i) => ({
                            open: !sp.closed,
                            operation: i > 0 && evenOdd ? 'exclude' : 'combine',
                            fillRule: evenOdd ? 'even-odd' : 'non-zero',
                            knots: sp.knots.map(k => ({ linked: false, points: [k.ix, k.iy, k.x, k.y, k.ox, k.oy] })),
                        })),
                    },
                    vectorFill: gradient || { type: 'color', color: rgb(fill || stroke) },
                };
                const strokeRel = stroke ? Math.min(1, stroke.a / (fill ? fill.a : stroke.a)) : 1;
                if (stroke) {
                    const dash = cs.strokeDasharray && cs.strokeDasharray !== 'none'
                        ? cs.strokeDasharray.split(/[\s,]+/).map(parseFloat).filter(v => !isNaN(v)) : [];
                    layer.vectorStroke = {
                        strokeEnabled: true,
                        fillEnabled: !!fill,
                        lineWidth: { units: 'Pixels', value: strokeWidth * scale },
                        lineAlignment: 'center',
                        lineCapType: { round: 'round', square: 'square' }[cs.strokeLinecap] || 'butt',
                        lineJoinType: { round: 'round', bevel: 'bevel' }[cs.strokeLinejoin] || 'miter',
                        lineDashSet: dash.map(v => ({ units: 'None', value: v / strokeWidth })),
                        opacity: strokeRel,
                        content: { type: 'color', color: rgb(stroke) },
                    };
                }
                const override = (fill ? (gradient ? 'fill-opacity:1;' : `fill:${css(fill)};fill-opacity:1;`) : '') +
                    (stroke ? `stroke:${css(stroke)};stroke-opacity:${strokeRel};` : '');
                const pixels = await renderPixels(el, (stroke ? strokeWidth * scale * 2 : 0) + 2, true, override);
                return pixels ? Object.assign(layer, pixels) : layer;
            };

            // <text> → 텍스트 레이어들 (x/y 를 가진 tspan 은 각각 한 줄로 취급)
            const textLayers = async (el) => {
                if (hasEffects(el)) return [await rasterLayer(el, '텍스트')].filter(Boolean);
                const lines = [...el.children].filter(c => c.localName === 'tspan' && (c.hasAttribute('x') || c.hasAttribute('y') || c.hasAttribute('dy')));
                const runs = lines.length ? lines : [el];
                const m = el.getCTM();
                if (!m) return [];
                const firstLen = (node, prop) => {
                    const list = node[prop] && node[prop].baseVal;
                    return list && list.numberOfItems ? list.getItem(0).value : null;
                };
                const baseX = firstLen(el, 'x') || 0, baseY = firstLen(el, 'y') || 0;
                const out = [];
                let curY = baseY;
                for (const run of runs) {
                    const text = run.textContent.replace(/\s+/g, ' ').trim();
                    if (!text) continue;
                    const cs = getComputedStyle(run);
                    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
                    const fill = parseColor(cs.fill);
                    if (!fill || /^url\(/.test(cs.fill)) { const r = await rasterLayer(run, text); if (r) out.push(r); continue; }
                    fill.a *= parseFloat(cs.fillOpacity);
                    const fontSize = parseFloat(cs.fontSize) || 16;
                    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
                    let x = run === el ? baseX : (firstLen(run, 'x') ?? baseX);
                    let y;
                    if (run === el) y = baseY;
                    else if (run.hasAttribute('y')) y = firstLen(run, 'y');
                    else y = curY + (firstLen(run, 'dy') || 0);
                    curY = y;
                    const baseline = run.getAttribute('dominant-baseline') || el.getAttribute('dominant-baseline') || cs.dominantBaseline;
                    if (baseline === 'middle' || baseline === 'central') y += fontSize * 0.35;
                    else if (baseline === 'hanging' || baseline === 'text-before-edge') y += fontSize * 0.8;
                    const anchor = cs.textAnchor;
                    const opacity = opacityOf(run);
                    const layer = {
                        name: (run === el ? layerName(el, '') : '') || text.slice(0, 40),
                        opacity: opacity * fill.a,
                        text: {
                            text,
                            transform: [m.a, m.b, m.c, m.d, m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f],
                            antiAlias: 'smooth',
                            style: {
                                font: { name: fontName(cs.fontFamily, bold, defaultFont) },
                                fontSize,
                                fillColor: rgb(fill),
                                ...(parseFloat(cs.letterSpacing) ? { tracking: Math.round(parseFloat(cs.letterSpacing) / fontSize * 1000) } : {}),
                            },
                            paragraphStyle: { justification: { middle: 'center', end: 'right' }[anchor] || 'left' },
                        },
                    };
                    const pixels = await renderPixels(run === el ? el : run, Math.ceil(fontSize * 0.3) + 2, true, `fill:${css(fill)};fill-opacity:1;`);
                    out.push(pixels ? Object.assign(layer, pixels) : layer);
                }
                return out;
            };

            const build = async (parent) => {
                const result = [];
                for (const child of parent.children) {
                    const tag = child.localName;
                    if (SKIP_TAGS.has(tag)) continue;
                    const cs = getComputedStyle(child);
                    if (cs.display === 'none') continue;
                    if (GROUP_TAGS.has(tag)) {
                        const children = await build(child);
                        if (children.length) result.push({ name: groupName(child), opened: true, children });
                        continue;
                    }
                    if (cs.visibility === 'hidden') continue;
                    if (SHAPE_TAGS.has(tag)) {
                        const layer = await shapeLayer(child);
                        if (layer) result.push(layer);
                    } else if (tag === 'text') {
                        result.push(...await textLayers(child));
                    } else {
                        const layer = await rasterLayer(child, tag === 'image' ? '이미지' : tag);
                        if (layer) result.push(layer);
                    }
                }
                return result;
            };

            if (options.onProgress) options.onProgress('레이어 변환 중...');
            const children = await build(root);
            const composite = root.cloneNode(true);
            composite.removeAttribute('style');
            const canvas = await renderToCanvas(composite, W, H);
            return agPsd.writePsd({ width: W, height: H, canvas, children });
        } finally {
            host.remove();
        }
    }

    async function download(svgInput, fileName, options) {
        const buffer = await convert(svgInput, options);
        const name = /\.psd$/i.test(fileName || '') ? fileName : (fileName || 'image') + '.psd';
        const url = URL.createObjectURL(new Blob([buffer], { type: 'image/vnd.adobe.photoshop' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return name;
    }

    window.SVGtoPSD = { convert, download, loadAgPsd };
})();
