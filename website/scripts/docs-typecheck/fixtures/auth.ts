// Huddle's session check. `teams` is for the tags examples.
export declare function verifySession(token: string | null | undefined): Promise<{
  id: string;
  name: string;
  role: 'admin' | 'member' | 'guest';
  teams: string[];
} | null>;
