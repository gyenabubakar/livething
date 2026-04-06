export {};

declare global {
  interface WskitServerRegistry {
    "chat":     {
      ctx: {
        send(event: "message", payload: { text: string }): void;
        broadcast(event: "message", payload: { text: string }): void;
        send(event: "alert", payload: { level: 'info' | 'warn' }): void;
        broadcast(event: "alert", payload: { level: 'info' | 'warn' }): void;
        ack(): void;
      };
      outgoing:       {
        "message": { text: string };
        "alert": { level: 'info' | 'warn' };
      };
      incomingContexts: {
        "send-message": WskitServerRegistry["chat"]["ctx"];
      };
    };
  }
}
