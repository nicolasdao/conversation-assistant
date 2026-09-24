// Minimal typings for the parts of sherpa-onnx-node this project uses; the package ships none.
declare module "sherpa-onnx-node" {
  export interface Wave { samples: Float32Array; sampleRate: number }

  export interface VadConfig {
    sileroVad: {
      model: string; threshold: number; minSpeechDuration: number; minSilenceDuration: number;
      maxSpeechDuration?: number; windowSize: number;
    };
    sampleRate: number; numThreads: number; debug: boolean | number;
  }
  export interface SpeechSegment { start: number; samples: Float32Array }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    pop(): void;
    clear(): void;
    reset(): void;
    flush?(): void;
  }

  export class CircularBuffer {
    constructor(capacity: number);
    push(samples: Float32Array): void;
    get(startIndex: number, n: number, enableExternalBuffer?: boolean): Float32Array;
    pop(n: number): void;
    size(): number;
    head(): number;
    reset(): void;
  }

  export class LinearResampler {
    constructor(inputSampleRate: number, outputSampleRate: number);
    resample(samples: Float32Array): Float32Array;
    flush(samples: Float32Array): Float32Array;
  }

  export interface OnlineStream {
    acceptWaveform(obj: Wave): void;
    inputFinished(): void;
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads: number; debug: boolean | number });
    readonly dim: number;
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array;
  }

  export class SpeakerEmbeddingManager {
    constructor(dim: number);
    add(obj: { name: string; v: Float32Array }): boolean;
    addMulti(obj: { name: string; v: Float32Array[] }): boolean;
    remove(name: string): boolean;
    search(obj: { v: Float32Array; threshold: number }): string;
    contains(name: string): boolean;
    getNumSpeakers(): number;
    getAllSpeakerNames(): string[];
  }

  export function readWave(path: string, enableExternalBuffer?: boolean): Wave;
  export function writeWave(path: string, wave: Wave): boolean;

  const sherpa: {
    Vad: typeof Vad;
    CircularBuffer: typeof CircularBuffer;
    LinearResampler: typeof LinearResampler;
    SpeakerEmbeddingExtractor: typeof SpeakerEmbeddingExtractor;
    SpeakerEmbeddingManager: typeof SpeakerEmbeddingManager;
    readWave: typeof readWave;
    writeWave: typeof writeWave;
  };
  export default sherpa;
}
