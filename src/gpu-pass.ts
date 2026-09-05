import { Mesh, MeshGeometry, RenderTexture, Shader } from 'pixi.js';
import type { ShaderFromResources } from 'pixi.js';
import { vertex } from './shaders';

export type GpuPass = Mesh<MeshGeometry, Shader>;

export function createTarget() {
  return RenderTexture.create({
    width: 1, height: 1, resolution: 1, dynamic: true,
    scaleMode: 'linear', antialias: false,
  });
}

export function createPass(fragment: string, resources: ShaderFromResources['resources']): GpuPass {
  const geometry = new MeshGeometry({
    positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  geometry.batchMode = 'no-batch';
  const pass = new Mesh({ geometry, shader: Shader.from({ gl: { vertex, fragment }, resources }) });
  pass.state.blend = false;
  return pass;
}

export function resizePass(pass: GpuPass, width: number, height: number) {
  pass.geometry.positions = new Float32Array([0, 0, width, 0, width, height, 0, height]);
}

export function destroyPass(pass: GpuPass) {
  pass.shader?.destroy(true);
  pass.geometry.destroy();
  pass.destroy();
}
