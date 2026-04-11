/* oxlint-disable @typescript-eslint/no-explicit-any */
import { ack as ackPrimitive } from '../ack/index.ts';
import {
  _onBeforeSubscribe as onBeforeSubscribePrimitive,
  _onSubscribe as onSubscribePrimitive,
  _onUnsubscribe as onUnsubscribePrimitive,
} from '../channel/index.ts';
import { dedup as dedupPrimitive } from '../dedup/index.ts';
import { defineServer } from '../define-server.ts';
import { heartbeat as heartbeatPrimitive } from '../heartbeat/index.ts';
import { hibernation as hibernationPrimitive } from '../hibernation/index.ts';
import { passive as passivePrimitive } from '../passive/index.ts';
import { replay as replayPrimitive } from '../replay/index.ts';
import { sequence as sequencePrimitive } from '../sequence/index.ts';
import type { SubscribeHandler, UnsubscribeHandler } from '../channel/index.ts';
import type { IncomingHandler } from '../incoming/index.ts';
import type {
  BinaryHandler,
  ConnectHandler,
  DisconnectHandler,
  ErrorHandler,
  InitHandler,
  ShutdownHandler,
  UpgradeHandler,
  ValidationErrorHandler,
} from '../lifecycle.ts';
import type { PassiveChild } from '../passive/index.ts';
import type { ReceivedEvent } from '../received.ts';
import type { BoundServer } from './bound-factory-types.ts';
import type {
  BoundInitContext,
  BoundServerContext,
  BoundShutdownContext,
  ServerPrimitiveFactories,
} from './context-types.ts';

const DEFAULT_HEARTBEAT_TIMEOUT = 30_000;

function hasPrimitiveTag(value: unknown, tag: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasPrimitiveTag(entry, tag));
  }

  if (!value || typeof value !== 'object') return false;
  if ('__wskit' in value && value.__wskit === tag) return true;

  if ('primitives' in value && Array.isArray((value as { primitives?: unknown[] }).primitives)) {
    return (value as { primitives: unknown[] }).primitives.some((child) => {
      return hasPrimitiveTag(child, tag);
    });
  }

  return false;
}

function buildDefaultInfrastructure<TFactories extends ServerPrimitiveFactories>(
  factories: TFactories,
  explicitPrimitives: readonly unknown[],
): unknown[] {
  const injected: unknown[] = [];

  if ('_ack' in factories && !hasPrimitiveTag(explicitPrimitives, 'ack')) {
    injected.push((factories._ack ?? ackPrimitive)());
  }

  const passiveChildren: PassiveChild[] = [];

  if ('_heartbeat' in factories && !hasPrimitiveTag(explicitPrimitives, 'heartbeat')) {
    passiveChildren.push(
      (factories._heartbeat ?? heartbeatPrimitive)({ timeout: DEFAULT_HEARTBEAT_TIMEOUT }),
    );
  }

  if ('_sequence' in factories && !hasPrimitiveTag(explicitPrimitives, 'sequence')) {
    passiveChildren.push((factories._sequence ?? sequencePrimitive)());
  }

  if ('_dedup' in factories && !hasPrimitiveTag(explicitPrimitives, 'dedup')) {
    passiveChildren.push((factories._dedup ?? dedupPrimitive)());
  }

  if (passiveChildren.length) {
    if ('_passive' in factories) {
      injected.push((factories._passive ?? passivePrimitive)(...passiveChildren));
    } else {
      injected.push(...passiveChildren);
    }
  }

  if ('_replay' in factories && !hasPrimitiveTag(explicitPrimitives, 'replay')) {
    injected.push((factories._replay ?? replayPrimitive)());
  }

  if ('_hibernation' in factories && !hasPrimitiveTag(explicitPrimitives, 'hibernation')) {
    injected.push((factories._hibernation ?? hibernationPrimitive)(true));
  }

  return injected;
}

/**
 * Bind a set of imported primitive factories to one named server.
 *
 * The returned helpers keep the flat functional style, but they also give the
 * code generator one stable anchor: a server key plus a known primitive set.
 *
 * Things that are obvious from the primitive set are inferred directly.
 * Example: if you pass `_ack`, handlers get `ctx.ack()`.
 *
 * The hard exact pieces such as event maps come later from generated
 * `ServerRegistry` declarations written by `@wskit/server-vite`.
 */
export function server<
  const TName extends string,
  const TFactories extends ServerPrimitiveFactories,
>(name: TName, factories: TFactories): BoundServer<TName, TFactories> {
  const define = ((...primitives: readonly unknown[]) => {
    return defineServer(
      ...(buildDefaultInfrastructure(factories, primitives) as never[]),
      ...(primitives as never[]),
    );
  }) as typeof defineServer;

  const bound: Record<string, unknown> = {
    define,
    name,
  };

  for (const [key, value] of Object.entries(factories)) {
    const publicName = key.startsWith('_') ? key.slice(1) : key;

    switch (publicName) {
      case 'incoming':
        bound.incoming = ((
          event: ReceivedEvent<string, unknown>,
          handler: IncomingHandler<any, any>,
        ) => (value as (...args: any[]) => unknown)(event, handler)) as any;
        break;

      case 'request':
        bound.request = ((...args: any[]) => {
          return (value as (...inner: any[]) => unknown)(...args);
        }) as any;
        break;

      case 'scheduled':
        bound.scheduled = ((...args: any[]) => {
          return (value as (...inner: any[]) => unknown)(...args);
        }) as any;
        break;

      case 'intercept':
        bound.intercept = ((...args: any[]) => {
          return (value as (...inner: any[]) => unknown)(...args);
        }) as any;
        break;

      case 'onInit':
        bound.onInit = ((handler: InitHandler<BoundInitContext>) => {
          return (value as (inner: InitHandler<BoundInitContext>) => unknown)(handler);
        }) as any;
        break;

      case 'onConnect':
        bound.onConnect = ((handler: ConnectHandler<BoundServerContext<TName, TFactories>>) => {
          return (
            value as (inner: ConnectHandler<BoundServerContext<TName, TFactories>>) => unknown
          )(handler);
        }) as any;
        break;

      case 'onDisconnect':
        bound.onDisconnect = ((
          handler: DisconnectHandler<BoundServerContext<TName, TFactories>>,
        ) => {
          return (
            value as (inner: DisconnectHandler<BoundServerContext<TName, TFactories>>) => unknown
          )(handler);
        }) as any;
        break;

      case 'onShutdown':
        bound.onShutdown = ((handler: ShutdownHandler<BoundShutdownContext>) => {
          return (value as (inner: ShutdownHandler<BoundShutdownContext>) => unknown)(handler);
        }) as any;
        break;

      case 'onError':
        bound.onError = ((handler: ErrorHandler<BoundServerContext<TName, TFactories>>) => {
          return (value as (inner: ErrorHandler<BoundServerContext<TName, TFactories>>) => unknown)(
            handler,
          );
        }) as any;
        break;

      case 'onUpgrade':
        bound.onUpgrade = ((handler: UpgradeHandler) => {
          return (value as (inner: UpgradeHandler) => unknown)(handler);
        }) as any;
        break;

      case 'onBinary':
        bound.onBinary = ((handler: BinaryHandler<BoundServerContext<TName, TFactories>>) => {
          return (
            value as (inner: BinaryHandler<BoundServerContext<TName, TFactories>>) => unknown
          )(handler);
        }) as any;
        break;

      case 'onValidationError':
        bound.onValidationError = ((
          handler: ValidationErrorHandler<BoundServerContext<TName, TFactories>>,
        ) => {
          return (
            value as (
              inner: ValidationErrorHandler<BoundServerContext<TName, TFactories>>,
            ) => unknown
          )(handler);
        }) as any;
        break;

      case 'onBeforeSubscribe':
        bound.onBeforeSubscribe = ((...args: any[]) => {
          return (value as (...inner: any[]) => unknown)(...args);
        }) as any;
        break;

      case 'onSubscribe':
        bound.onSubscribe = ((handler: SubscribeHandler<any>) => {
          return (value as (inner: SubscribeHandler<any>) => unknown)(handler);
        }) as any;
        break;

      case 'onUnsubscribe':
        bound.onUnsubscribe = ((handler: UnsubscribeHandler<any>) => {
          return (value as (inner: UnsubscribeHandler<any>) => unknown)(handler);
        }) as any;
        break;

      case 'namespace':
        bound.namespace = ((...args: any[]) => {
          return (value as (...inner: any[]) => unknown)(...args);
        }) as any;
        break;

      case 'channel':
        bound.channel = ((...args: any[]) => {
          return (value as (...inner: any[]) => unknown)(...args);
        }) as any;
        break;

      default:
        bound[publicName] = value;
        break;
    }
  }

  if (!('onBeforeSubscribe' in bound)) {
    const value = factories._onBeforeSubscribe ?? onBeforeSubscribePrimitive;
    bound.onBeforeSubscribe = ((...args: any[]) => {
      return (value as (...inner: any[]) => unknown)(...args);
    }) as any;
  }

  if (!('onSubscribe' in bound)) {
    const value = factories._onSubscribe ?? onSubscribePrimitive;
    bound.onSubscribe = ((handler: SubscribeHandler<any>) => {
      return (value as (inner: SubscribeHandler<any>) => unknown)(handler);
    }) as any;
  }

  if (!('onUnsubscribe' in bound)) {
    const value = factories._onUnsubscribe ?? onUnsubscribePrimitive;
    bound.onUnsubscribe = ((handler: UnsubscribeHandler<any>) => {
      return (value as (inner: UnsubscribeHandler<any>) => unknown)(handler);
    }) as any;
  }

  return bound as BoundServer<TName, TFactories>;
}
