declare global {
  interface Window {
    __livethingEncode: (frame: unknown) => string;
    __livethingDecode: (text: string) => any;
  }
}

export {};
