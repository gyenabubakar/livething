// React Native is not installed in this repo, so this holds its real signatures for what the docs use.
import type { JSX, ReactNode } from './react';

type ViewStyle = { width?: number; height?: number; backgroundColor?: string };

export declare const StyleSheet: {
  create<T extends Record<string, ViewStyle>>(styles: T): T;
};
export declare function View(props: { style?: ViewStyle; children?: ReactNode }): JSX.Element;
export declare function Text(props: { style?: ViewStyle; children?: ReactNode }): JSX.Element;
type TextSelection = { start: number; end: number };
export declare function TextInput(props: {
  value?: string;
  selection?: TextSelection;
  onChangeText?: (text: string) => void;
  onSelectionChange?: (event: { nativeEvent: { selection: TextSelection } }) => void;
}): JSX.Element;
export declare function ActivityIndicator(props: { size?: 'small' | 'large' }): JSX.Element;
export declare function FlatList<T>(props: {
  data: ArrayLike<T> | null | undefined;
  renderItem: (info: { item: T; index: number }) => JSX.Element | null;
  keyExtractor?: (item: T, index: number) => string;
}): JSX.Element;

type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

export declare const AppState: {
  currentState: AppStateStatus;
  addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void };
};
