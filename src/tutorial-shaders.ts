import { noise } from './shaders';

const header = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
`;

export const fractalFragment = header + /* glsl */ `
uniform vec2 uSize;
uniform float uReferenceScale;
uniform float uSeed;
uniform float uComplexity;
uniform float uSubInfluence;
${noise}
void main() {
  vec2 p = vUV * uSize / uReferenceScale;
  vec2 q = p / 100.0 + uSeed;
  float total = 0.0, weight = 1.0, weightSum = 0.0;
  for (int i = 0; i < 10; i++) {
    if (float(i) >= uComplexity) break;
    total += noise(q) * weight;
    weightSum += weight;
    weight *= uSubInfluence;
    q = mat2(0.8, -0.6, 0.6, 0.8) * q * 2.0 + 13.7;
  }
  float detailed = clamp(0.5 + (total / weightSum - 0.5) * 2.4, 0.0, 1.0);
  finalColor = vec4(detailed, fbm(p / 100.0 + uSeed + 91.0), 0.0, 1.0);
}
`;

export const boxBlurFragment = header + /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uTarget;
uniform vec2 uSize;
uniform vec2 uDirection;
uniform float uRadius;
uniform float uRematte;
uniform float uReadAlpha;
float sampleMask(vec2 uv) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  vec4 value = texture(uInput, uv);
  return mix(value.r, value.a, uReadAlpha);
}
void main() {
  float value = 0.0;
  for (int i = -8; i <= 8; i++) {
    value += sampleMask(vUV + uDirection / uSize * uRadius * float(i) / 8.0);
  }
  value /= 17.0;
  value *= mix(1.0, texture(uTarget, vUV).a, uRematte);
  finalColor = vec4(value, value, value, 1.0);
}
`;

export const displacementMapFragment = header + /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uMask;
uniform float uExteriorNoise;
void main() {
  vec2 fractal = texture(uNoise, vUV).rg;
  float mask = texture(uMask, vUV).r;
  float signal = (fractal.r - 0.5) * 2.0 * mask;
  signal = mix(signal, (fractal.g - 0.5) * 2.0, uExteriorNoise);
  // 128 is the exact neutral byte; decoding around 0.5 would drift on RGBA8.
  float encoded = (128.0 + clamp(signal, -1.0, 1.0) * 127.0) / 255.0;
  finalColor = vec4(encoded, mask, 0.0, 1.0);
}
`;

const stateSampling = /* glsl */ `
uniform sampler2D uState;
vec3 stateAt(vec2 uv) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
  return texture(uState, uv).rgb;
}
`;

export const pasteFragment = header + /* glsl */ `
${stateSampling}
uniform sampler2D uSource;
uniform sampler2D uTarget;
uniform vec2 uSize;
uniform vec4 uBounds;
uniform float uTime;
uniform float uStep;
uniform float uFrame;
uniform float uDrawing;
uniform float uLifetime;
uniform float uFadeDuration;
uniform float uRevealDuration;
uniform float uDrops;
uniform float uAccumulation;
${noise}
void main() {
  vec3 old = stateAt(vUV);
  bool fillingDrops = uDrops > 0.5 && uDrawing < 0.5;
  // Keep deposited ink inside the silhouette; let exterior seepage dissipate.
  float retention = fillingDrops ? mix(uAccumulation, 1.0,
    smoothstep(0.0, 0.1, texture(uTarget, vUV).a)) : uAccumulation;
  float pigment = old.r * retention;
  float deposit = old.g;
  float life = old.b;
  if (uDrawing > 0.5) {
    life = max(0.0, life - uStep / uLifetime);
    float before = smoothstep(0.0, uFadeDuration / uLifetime, old.b);
    float after = smoothstep(0.0, uFadeDuration / uLifetime, life);
    float fade = before > 0.0001 ? min(1.0, after / before) : 0.0;
    deposit *= fade;
    // Retain the local pen source during its hold/fade, just as AE's source
    // stays under the paste layer. Fresh strokes never reset the entire canvas.
    pigment = max(pigment * fade, deposit);
  }
  float source = texture(uSource, vUV).a;
  if (uDrawing < 0.5 && uDrops < 0.5) {
    float localX = (vUV.x - uBounds.x) / max(uBounds.z, 0.001);
    source *= smoothstep(localX * 0.9, localX * 0.9 + 0.06, uTime / uRevealDuration);
  }
  pigment = max(pigment, source);
  deposit = max(deposit, source);
  if (source > 0.01) life = 1.0;
  vec3 value = clamp(vec3(pigment, deposit, life), 0.0, 1.0);
  vec3 dither = vec3(hash(vUV * uSize + uFrame),
    hash(vUV * uSize + uFrame + 23.4), hash(vUV * uSize + uFrame + 71.8));
  finalColor = vec4(floor(value * 255.0 + dither) / 255.0, 1.0);
}
`;

export const directionalFragment = header + /* glsl */ `
${stateSampling}
uniform sampler2D uDisplacement;
uniform vec2 uSize;
uniform vec2 uDirection;
uniform float uDisplacementAmount;
uniform float uDropFill;
uniform float uAccumulation;
void main() {
  vec3 original = stateAt(vUV);
  float field = (texture(uDisplacement, vUV).r * 255.0 - 128.0) / 127.0;
  vec3 moved = stateAt(vUV - uDirection * field * uDisplacementAmount / uSize);
  float life = moved.r > original.r ? max(original.b, moved.b) : original.b;
  // AE darken = min luminance. With positive pigment it is max coverage.
  // Drop filling deposits pigment instead of evaporating it on every frame.
  // Accumulation controls how much newly transported ink adheres to the paper.
  float incoming = mix(moved.r, mix(original.r, moved.r, uAccumulation), uDropFill);
  finalColor = vec4(max(original.r, incoming), original.g, life, 1.0);
}
`;

export const medianFragment = header + /* glsl */ `
${stateSampling}
uniform vec2 uSize;
uniform float uMedianRadius;
uniform float uDropFill;
void main() {
  vec3 center = stateAt(vUV);
  float values[9];
  float life = center.b;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 sampleValue = stateAt(vUV + vec2(float(x), float(y)) * uMedianRadius / uSize);
      values[(y + 1) * 3 + x + 1] = sampleValue.r;
      life = max(life, sampleValue.b);
    }
  }
  for (int i = 1; i < 9; i++) {
    for (int j = 0; j < 8; j++) {
      if (j >= i) break;
      float low = min(values[i], values[j]);
      values[i] = max(values[i], values[j]);
      values[j] = low;
    }
  }
  float result = max(values[4], center.g * uDropFill);
  finalColor = vec4(result, center.g, result > center.r ? life : center.b, 1.0);
}
`;
