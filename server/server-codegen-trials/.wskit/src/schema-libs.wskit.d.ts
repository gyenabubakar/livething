export {};

declare global {
  interface WskitServerRegistry {
    "schema-libs":     {
      ctx: {
        send(event: "schema-message", payload: { roomId: string; text: string }): void;
        broadcast(event: "schema-message", payload: { roomId: string; text: string }): void;
        send(event: "typing-state", payload: { roomId: string; userId: string }): void;
        broadcast(event: "typing-state", payload: { roomId: string; userId: string }): void;
      };
      outgoing:       {
        "schema-message": { roomId: string; text: string };
        "typing-state": { roomId: string; userId: string };
      };
      incomingContexts: {
        "join-room": WskitServerRegistry["schema-libs"]["ctx"];
        "start-typing": WskitServerRegistry["schema-libs"]["ctx"];
      };
      requestContexts: {
        "get-history": WskitServerRegistry["schema-libs"]["ctx"];
      };
    };
  }
}
