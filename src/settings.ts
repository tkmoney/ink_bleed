export type SourceMode = 'text' | 'draw' | 'image';
export type PresetName = 'India ink' | 'Fountain pen' | 'Wine wash' | 'Sepia' | 'Custom';
export const googleFonts = ['Bonheur Royale', 'Eagle Lake'];

export interface Settings {
  model: 'tutorial' | 'capillary';
  diagnostic: 'ink' | 'source' | 'target' | 'displacement';
  displacement: number;
  accumulation: number;
  targetFeather: number;
  edgeSoftness: number;
  complexity: number;
  subInfluence: number;
  exteriorNoise: number;
  medianRadius: number;
  seedWidth: number;
  dropSize: number;
  dropSpacing: number;
  dropStagger: number;
  mode: SourceMode;
  text: string;
  font: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  reveal: 'write-on' | 'drops';
  revealDuration: number;
  color: string;
  spread: number;
  turbulence: number;
  grain: number;
  density: number;
  edge: number;
  dryTime: number;
  brushSize: number;
  fadeDelay: number;
  fadeDuration: number;
  imageScale: number;
  imageThreshold: number;
  imageContrast: number;
  imageChannel: 'luminance' | 'alpha';
  invertImage: boolean;
  paperStrength: number;
  quality: number;
  speed: number;
  seed: number;
  preset: PresetName;
}

export const defaults: Settings = {
  model: 'tutorial',
  diagnostic: 'ink',
  displacement: 10,
  accumulation: 0.95,
  targetFeather: 20,
  edgeSoftness: 2,
  complexity: 10,
  subInfluence: 0.9,
  exteriorNoise: 0.08,
  medianRadius: 1,
  seedWidth: 3,
  dropSize: 16,
  dropSpacing: 180,
  dropStagger: 0,
  mode: 'text',
  text: 'The Lord of the Rings',
  font: 'Eagle Lake',
  fontSize: 174,
  bold: false,
  italic: true,
  reveal: 'write-on',
  revealDuration: 3.8,
  color: '#252833',
  spread: 0.65,
  turbulence: 0.65,
  grain: 0.3,
  density: 0.86,
  edge: 0.48,
  dryTime: 6,
  brushSize: 22,
  fadeDelay: 2.5,
  fadeDuration: 5,
  imageScale: 0.68,
  imageThreshold: 0.55,
  imageContrast: 1.35,
  imageChannel: 'luminance',
  invertImage: false,
  paperStrength: 1,
  quality: 2000,
  speed: 1,
  seed: 12,
  preset: 'India ink',
};

type PigmentPreset = Pick<Settings, 'color' | 'spread' | 'turbulence' | 'grain' | 'density' | 'edge' | 'dryTime'>;

export const presets: Record<Exclude<PresetName, 'Custom'>, PigmentPreset> = {
  'India ink': {
    color: '#252833', spread: 0.65, turbulence: 0.65, grain: 0.42,
    density: 0.86, edge: 0.48, dryTime: 6,
  },
  'Fountain pen': {
    color: '#243955', spread: 0.32, turbulence: 0.4, grain: 0.22,
    density: 0.76, edge: 0.65, dryTime: 4,
  },
  'Wine wash': {
    color: '#692d43', spread: 1.1, turbulence: 0.82, grain: 0.58,
    density: 0.62, edge: 0.75, dryTime: 8,
  },
  Sepia: {
    color: '#69472c', spread: 0.85, turbulence: 0.7, grain: 0.68,
    density: 0.7, edge: 0.6, dryTime: 7,
  },
};

export function hexToRgb(hex: string): Float32Array {
  const value = Number.parseInt(hex.slice(1), 16);
  return new Float32Array([(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255]);
}
