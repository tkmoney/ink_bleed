export const vertex = /* glsl */ `
precision highp float;
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix
    * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}
`;

export const noise = /* glsl */ `
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
    mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float n = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    n += a * noise(p);
    p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.07 + 17.1;
    a *= 0.5;
  }
  return n;
}
`;

// Stationary paper field: no evolving noise that would make dried edges shimmer.
export const mediumFragment = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uPaper;
uniform vec2 uSize;
uniform vec2 uPaperScale;
uniform float uSeed;
${noise}
void main() {
  vec2 p = vUV * uSize;
  vec2 paperUV = (vUV - 0.5) * uPaperScale + 0.5;
  vec3 paper = texture(uPaper, paperUV).rgb;
  float fiber = noise(p * vec2(0.11, 1.3) + uSeed);
  float coarse = fbm(p * 0.045 + uSeed);
  float fine = noise(p * 0.7 + uSeed);
  float luminance = dot(paper, vec3(0.299, 0.587, 0.114));
  finalColor = vec4(coarse, mix(fine, luminance, 0.48), fiber, 1.0);
}
`;

// R = mobile pigment, G = original deposit, B = remaining local lifetime.
// Every pass reads one texture and writes the other; never sample the active target.
export const simulationFragment = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uState;
uniform sampler2D uSource;
uniform sampler2D uMedium;
uniform vec2 uSize;
uniform vec4 uBounds;
uniform float uStep;
uniform float uTime;
uniform float uFrame;
uniform float uSpread;
uniform float uTurbulence;
uniform float uDryTime;
uniform float uLifetime;
uniform float uFadeDuration;
uniform float uDrawing;
uniform float uRevealDuration;
uniform float uDrops;
uniform float uDropStagger;
uniform float uSeed;
${noise}
vec3 stateAt(vec2 uv) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
  return texture(uState, uv).rgb;
}
void main() {
  vec3 old = stateAt(vUV);
  vec3 medium = texture(uMedium, vUV).rgb;
  float lifetime = mix(uDryTime, uLifetime, uDrawing);
  float flow = mix(0.8, 0.22 + medium.r * 1.7, uTurbulence);
  vec2 pixel = 1.0 / uSize;
  float radius = uSpread * (0.10 + flow * 0.18);
  float pigment = old.r;
  float remaining = old.b;
  for (int i = 0; i < 8; i++) {
    float angle = float(i) * 0.785398163;
    vec2 direction = vec2(cos(angle), sin(angle));
    vec3 neighbor = stateAt(vUV + direction * pixel * radius);
    float neighborWet = clamp(1.0 - (1.0 - neighbor.b) * lifetime / uDryTime, 0.0, 1.0);
    float transmission = mix(0.945, 0.992, medium.r)
      - uTurbulence * (1.0 - medium.b) * 0.025;
    float carried = neighbor.r * transmission;
    pigment = max(pigment, mix(old.r, carried, neighborWet * 0.82));
    if (carried > old.r + 0.003 && neighborWet > 0.01) {
      remaining = max(remaining, neighbor.b);
    }
  }
  remaining = max(0.0, remaining - uStep / lifetime);
  float deposit = old.g;
  if (uDrawing > 0.5) {
    float fadeRange = uFadeDuration / lifetime;
    float before = smoothstep(0.0, fadeRange, old.b);
    float after = smoothstep(0.0, fadeRange, remaining);
    float fade = before > 0.0001 ? min(1.0, after / before) : 0.0;
    pigment *= fade;
    deposit *= fade;
  }
  float mask = texture(uSource, vUV).a;
  float source = mask;
  if (uDrawing < 0.5) {
    float localTime = uTime;
    float localX = (vUV.x - uBounds.x) / max(uBounds.z, 0.001);
    float front = localX * 0.82 + (medium.r - 0.5) * 0.2;
    if (uDrops > 0.5) {
      vec2 cell = (vUV - uBounds.xy) * uSize / 105.0;
      vec2 center = floor(cell) + vec2(0.25 + hash(floor(cell) + uSeed) * 0.5,
        0.25 + hash(floor(cell) + uSeed + 41.0) * 0.5);
      front = length(cell - center) * 0.85 + medium.r * 0.12;
      localTime -= hash(floor(cell) + uSeed + 97.0) * uDropStagger;
    }
    float progress = clamp(localTime / uRevealDuration, 0.0, 1.0);
    source *= smoothstep(front, front + 0.1, progress);
    source *= 1.0 - step(uRevealDuration + 0.1, localTime);
  }
  if (source > 0.001) {
    float variation = 0.8 + 0.2 * medium.g;
    pigment = max(pigment, source * variation);
    deposit = max(deposit, source);
    remaining = max(remaining, source > 0.03 ? 1.0 : 0.0);
  }
  vec3 result = clamp(vec3(pigment, deposit, remaining), 0.0, 1.0);
  // Unbiased quantization lets very slow diffusion and fades work on RGBA8,
  // including devices without renderable floating-point textures.
  vec3 dither = vec3(hash(vUV * uSize + uFrame),
    hash(vUV * uSize + uFrame + 23.4), hash(vUV * uSize + uFrame + 71.8));
  finalColor = vec4(floor(result * 255.0 + dither) / 255.0, 1.0);
}
`;

export const compositeFragment = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uState;
uniform sampler2D uMedium;
uniform sampler2D uPaper;
uniform sampler2D uSource;
uniform sampler2D uTarget;
uniform sampler2D uDisplacement;
uniform vec2 uSize;
uniform vec2 uPaperScale;
uniform vec3 uInkColor;
uniform float uDensity;
uniform float uGrain;
uniform float uEdge;
uniform float uPaperStrength;
uniform float uTurbulence;
uniform float uTutorial;
uniform float uDiagnostic;
uniform float uLiveSource;
void main() {
  if (uDiagnostic > 0.5) {
    float source = mix(texture(uSource, vUV).a, texture(uState, vUV).g, uLiveSource);
    float value = uDiagnostic < 1.5 ? 1.0 - source
      : uDiagnostic < 2.5 ? 1.0 - texture(uTarget, vUV).a
      : texture(uDisplacement, vUV).r;
    finalColor = vec4(vec3(value), 1.0);
    return;
  }
  vec3 medium = texture(uMedium, vUV).rgb;
  vec2 pixel = 1.0 / uSize;
  vec2 inkUV = vUV + (vec2(medium.r, medium.b) - 0.5) * pixel * uTurbulence * 2.8 * (1.0 - uTutorial);
  vec3 data = texture(uState, inkUV).rgb;
  float blur = (
    texture(uState, vUV + vec2(pixel.x * 2.0, 0)).r +
    texture(uState, vUV - vec2(pixel.x * 2.0, 0)).r +
    texture(uState, vUV + vec2(0, pixel.y * 2.0)).r +
    texture(uState, vUV - vec2(0, pixel.y * 2.0)).r) * 0.25;
  float rim = abs(data.r - blur) * 2.2;
  float fiberEdge = (medium.b - 0.5) * uTurbulence * 0.2;
  float body = smoothstep(0.27 + fiberEdge, 0.43 + fiberEdge, data.r);
  float feather = smoothstep(0.09, 0.3, data.r) * (1.0 - body) * (0.3 + medium.b * 0.7);
  float core = data.g * 0.74;
  float coverage = max(body * 0.88 + feather * 0.16, core);
  coverage = mix(coverage, data.r, uTutorial);
  coverage *= 1.0 - uGrain * (0.2 + (1.0 - medium.g) * 0.8) * 0.85;
  coverage = clamp(coverage + rim * uEdge, 0.0, 1.0);
  float opticalDensity = coverage * uDensity * 3.6;
  vec3 transmittance = exp(-opticalDensity * (vec3(1.0) - uInkColor));
  vec2 paperUV = (vUV - 0.5) * uPaperScale + 0.5;
  vec3 paper = texture(uPaper, paperUV).rgb;
  paper = mix(vec3(0.965, 0.952, 0.92), paper, uPaperStrength);
  finalColor = vec4(paper * transmittance, 1.0);
}
`;
