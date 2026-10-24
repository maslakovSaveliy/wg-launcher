// THROWAWAY spike (runtime-compat). Not product code.
// One fixed WebGL2 scene for the frame-time (H7), cold-start (H8) and memory (H9) measurements.
// Everything is a function of the frame index and a fixed seed, never of wall time, so every
// runtime renders the same sequence of frames. `load` is the per-pixel loop count of the
// background pass; it is the knob for the H7 calibration and is recorded with every result.

const INSTANCES = 1024;
const SEED = 0x5eed1234;

const BACKGROUND_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Fixed amount of ALU work per pixel: `u_load` iterations without early exit.
const BACKGROUND_FS = `#version 300 es
precision highp float;
uniform vec2 u_size;
uniform float u_frame;
uniform int u_load;
out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec2 c = (uv - 0.5) * vec2(3.0, 2.0) + vec2(-0.5 + 0.2 * sin(u_frame * 0.01), 0.0);
  vec2 z = vec2(0.0);
  float acc = 0.0;
  for (int i = 0; i < u_load; i++) {
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    z = clamp(z, vec2(-4.0), vec2(4.0));
    acc += exp(-dot(z, z));
  }
  float v = acc / float(max(u_load, 1));
  color = vec4(0.1 + 0.6 * v, 0.15 + 0.4 * v * v, 0.3 + 0.5 * sqrt(v), 1.0);
}`;

const CUBE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec4 a_instance; // xyz offset, w phase
uniform mat4 u_viewProj;
uniform float u_frame;
out vec3 v_normal;
out float v_shade;
mat3 rot(float a, float b) {
  float ca = cos(a), sa = sin(a), cb = cos(b), sb = sin(b);
  return mat3(ca, 0.0, -sa, 0.0, 1.0, 0.0, sa, 0.0, ca) * mat3(1.0, 0.0, 0.0, 0.0, cb, sb, 0.0, -sb, cb);
}
void main() {
  mat3 r = rot(u_frame * 0.02 + a_instance.w, u_frame * 0.013 + a_instance.w * 2.0);
  vec3 p = r * (a_pos * 0.35) + a_instance.xyz;
  v_normal = r * a_normal;
  v_shade = a_instance.w / 6.2831853;
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const CUBE_FS = `#version 300 es
precision highp float;
in vec3 v_normal;
in float v_shade;
out vec4 color;
void main() {
  float l = max(dot(normalize(v_normal), normalize(vec3(0.4, 0.8, 0.5))), 0.0);
  color = vec4(vec3(0.3 + 0.7 * l) * vec3(0.6 + 0.4 * v_shade, 0.7, 1.0 - 0.5 * v_shade), 1.0);
}`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function lookAt(eye, center, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, center));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    }
  }
  return out;
}

function cubeGeometry() {
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const data = [];
  for (const [n, u, v] of faces) {
    const corner = (su, sv) => [
      n[0] + su * u[0] + sv * v[0],
      n[1] + su * u[1] + sv * v[1],
      n[2] + su * u[2] + sv * v[2],
    ];
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
      data.push(...corner(su, sv), ...n);
    }
  }
  return new Float32Array(data);
}

/** Creates the scene on `canvas`. Returns { draw(frameIndex), gl, info }. */
export function createScene(canvas, { load }) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  const gl = canvas.getContext("webgl2", { antialias: false, powerPreference: "high-performance" });
  if (!gl) throw new Error("WebGL2 unavailable");

  const bg = program(gl, BACKGROUND_VS, BACKGROUND_FS);
  const cube = program(gl, CUBE_VS, CUBE_FS);
  const bgLoc = {
    size: gl.getUniformLocation(bg, "u_size"),
    frame: gl.getUniformLocation(bg, "u_frame"),
    load: gl.getUniformLocation(bg, "u_load"),
  };
  const cubeLoc = {
    viewProj: gl.getUniformLocation(cube, "u_viewProj"),
    frame: gl.getUniformLocation(cube, "u_frame"),
  };

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const geometry = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, geometry);
  gl.bufferData(gl.ARRAY_BUFFER, cubeGeometry(), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);

  const random = mulberry32(SEED);
  const instances = new Float32Array(INSTANCES * 4);
  for (let i = 0; i < INSTANCES; i++) {
    instances[i * 4] = (random() - 0.5) * 24;
    instances[i * 4 + 1] = (random() - 0.5) * 12;
    instances[i * 4 + 2] = (random() - 0.5) * 24;
    instances[i * 4 + 3] = random() * Math.PI * 2;
  }
  const instanceBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, instances, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 16, 0);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);
  const emptyVao = gl.createVertexArray();

  const projection = perspective(Math.PI / 3, canvas.width / canvas.height, 0.1, 100);

  function draw(frame) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(bg);
    gl.bindVertexArray(emptyVao);
    gl.uniform2f(bgLoc.size, canvas.width, canvas.height);
    gl.uniform1f(bgLoc.frame, frame);
    gl.uniform1i(bgLoc.load, load);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(cube);
    const angle = frame * 0.01; // fixed camera path, a function of the frame index only
    const eye = [Math.cos(angle) * 22, 6 + Math.sin(angle * 0.7) * 3, Math.sin(angle) * 22];
    gl.uniformMatrix4fv(cubeLoc.viewProj, false, multiply(projection, lookAt(eye, [0, 0, 0], [0, 1, 0])));
    gl.uniform1f(cubeLoc.frame, frame);
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, INSTANCES);
    gl.bindVertexArray(null);
  }

  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
  return {
    gl,
    draw,
    info: {
      renderer,
      softwareRenderer: typeof renderer === "string" ? /swiftshader/i.test(renderer) : null,
      load,
      instances: INSTANCES,
      seed: SEED,
      devicePixelRatio: dpr,
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      drawingBufferWidth: gl.drawingBufferWidth,
      drawingBufferHeight: gl.drawingBufferHeight,
    },
  };
}
