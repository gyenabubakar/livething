export {};

declare global {
  interface WskitServerRegistry {
    "all-primitives":     {
      ctx: {
        send(event: "message", payload: { text: string; room?: string }): void;
        broadcast(event: "message", payload: { text: string; room?: string }): void;
        send(event: "alert", payload: { level: 'info' | 'warn' | 'error' }): void;
        broadcast(event: "alert", payload: { level: 'info' | 'warn' | 'error' }): void;
        send(event: "usage", payload: { totalTokens: number }): void;
        broadcast(event: "usage", payload: { totalTokens: number }): void;
        ack(): void;
        sendReplay(event: "message", payload: { text: string; room?: string }, meta: { seq: number; messageId: string }): void;
        sendReplay(event: "alert", payload: { level: 'info' | 'warn' | 'error' }, meta: { seq: number; messageId: string }): void;
        sendReplay(event: "usage", payload: { totalTokens: number }, meta: { seq: number; messageId: string }): void;
      };
      outgoing:       {
        "message": { text: string; room?: string };
        "alert": { level: 'info' | 'warn' | 'error' };
        "usage": { totalTokens: number };
      };
      namespaces: {
        "notifications":         {
          ctx: {
            send(event: "message", payload: { text: string; room?: string }): void;
            broadcast(event: "message", payload: { text: string; room?: string }): void;
            send(event: "alert", payload: { level: 'info' | 'warn' | 'error' }): void;
            broadcast(event: "alert", payload: { level: 'info' | 'warn' | 'error' }): void;
            send(event: "usage", payload: { totalTokens: number }): void;
            broadcast(event: "usage", payload: { totalTokens: number }): void;
            ack(): void;
            sendReplay(event: "message", payload: { text: string; room?: string }, meta: { seq: number; messageId: string }): void;
            sendReplay(event: "alert", payload: { level: 'info' | 'warn' | 'error' }, meta: { seq: number; messageId: string }): void;
            sendReplay(event: "usage", payload: { totalTokens: number }, meta: { seq: number; messageId: string }): void;
            namespace: {
              name: "notifications";
              send(event: "notice", payload: { id: string; text: string }): void;
              broadcast(event: "notice", payload: { id: string; text: string }): void;
            };
          };
          outgoing:           {
            "notice": { id: string; text: string };
          };
        };
      };
      channels: {
        "general":         {
          ctx: {
            send(event: "message", payload: { text: string; room?: string }): void;
            broadcast(event: "message", payload: { text: string; room?: string }): void;
            send(event: "alert", payload: { level: 'info' | 'warn' | 'error' }): void;
            broadcast(event: "alert", payload: { level: 'info' | 'warn' | 'error' }): void;
            send(event: "usage", payload: { totalTokens: number }): void;
            broadcast(event: "usage", payload: { totalTokens: number }): void;
            ack(): void;
            sendReplay(event: "message", payload: { text: string; room?: string }, meta: { seq: number; messageId: string }): void;
            sendReplay(event: "alert", payload: { level: 'info' | 'warn' | 'error' }, meta: { seq: number; messageId: string }): void;
            sendReplay(event: "usage", payload: { totalTokens: number }, meta: { seq: number; messageId: string }): void;
            channel: {
              name: string;
              send(event: "announcement", payload: { text: string }): void;
              broadcast(event: "announcement", payload: { text: string }): void;
            };
          };
          outgoing:           {
            "announcement": { text: string };
          };
        };
        "rooms":         {
          ctx: {
            send(event: "message", payload: { text: string; room?: string }): void;
            broadcast(event: "message", payload: { text: string; room?: string }): void;
            send(event: "alert", payload: { level: 'info' | 'warn' | 'error' }): void;
            broadcast(event: "alert", payload: { level: 'info' | 'warn' | 'error' }): void;
            send(event: "usage", payload: { totalTokens: number }): void;
            broadcast(event: "usage", payload: { totalTokens: number }): void;
            ack(): void;
            sendReplay(event: "message", payload: { text: string; room?: string }, meta: { seq: number; messageId: string }): void;
            sendReplay(event: "alert", payload: { level: 'info' | 'warn' | 'error' }, meta: { seq: number; messageId: string }): void;
            sendReplay(event: "usage", payload: { totalTokens: number }, meta: { seq: number; messageId: string }): void;
            channel: {
              name: string;
              send(event: "typing", payload: { userId: string }): void;
              broadcast(event: "typing", payload: { userId: string }): void;
              send(event: "room-message", payload: { text: string }): void;
              broadcast(event: "room-message", payload: { text: string }): void;
              sendReplay(event: "typing", payload: { userId: string }, meta: { seq: number; messageId: string }): void;
              sendReplay(event: "room-message", payload: { text: string }, meta: { seq: number; messageId: string }): void;
            };
          };
          outgoing:           {
            "typing": { userId: string };
            "room-message": { text: string };
          };
        };
      };
      incomingContexts: {
        "send-message": WskitServerRegistry["all-primitives"]["ctx"];
        "dismiss-notice": WskitServerRegistry["all-primitives"]["namespaces"]["notifications"]["ctx"];
        "announce": WskitServerRegistry["all-primitives"]["channels"]["general"]["ctx"];
        "start-typing": WskitServerRegistry["all-primitives"]["channels"]["rooms"]["ctx"];
      };
      requestContexts: {
        "get-usage": WskitServerRegistry["all-primitives"]["ctx"];
        "get-notices": WskitServerRegistry["all-primitives"]["namespaces"]["notifications"]["ctx"];
        "get-room-members": WskitServerRegistry["all-primitives"]["channels"]["rooms"]["ctx"];
      };
      postInterceptContexts: {
        "start-typing": WskitServerRegistry["all-primitives"]["channels"]["rooms"]["ctx"];
      };
    };
  }
}
