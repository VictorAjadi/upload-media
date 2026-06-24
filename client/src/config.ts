export interface UploadMediaConfig {
  getCookie?: () => Promise<string | null> | string | null;
  encryptQueryString?: (data: any) => string | Promise<string>;
  showToast: {
    success: (msg: string) => void;
    error: (msg: string) => void;
    info: (msg: string) => void;
    warning: (msg: string) => void;
  };
  videoState: {
    getState: () => {
      videos: Record<number, { startTime?: number; endTime?: number | null; isMuted?: boolean; videoDuration?: number | null }>;
      clearVideoState: (key: string) => void;
    };
  };
  customTransformer?: (blob: Blob, options: any, onProgress: (p: number) => void) => Promise<Blob | Record<string, Blob>>;
}

let currentConfig: UploadMediaConfig = {
  getCookie: () => null,
  encryptQueryString: (data) => JSON.stringify(data),
  showToast: {
    success: console.log,
    error: console.error,
    info: console.info,
    warning: console.warn,
  },
  videoState: {
    getState: () => ({
      videos: {},
      clearVideoState: () => {},
    }),
  },
};

export const setUploadMediaConfig = (config: Partial<UploadMediaConfig>) => {
  currentConfig = { ...currentConfig, ...config };
};

export const getUploadMediaConfig = () => currentConfig;
