// @flow
"use strict";

const symbolObservable = require("symbol-observable").default;
const {
  tryCatch,
  tryCatchResult,
  symbolError,
  popError
} = require("./try-catch");
import type {
  IClassicObservable,
  IClassicSubscriptionObserver,
  IDisposable
} from "./classic-observable";

export interface ISubscriptionObserver<T, E = Error> {
  next(value: T): void;
  error(errorValue: E): void;
  complete(): void;
  +closed: boolean;
}

export interface ISubscription {
  unsubscribe(): void;
  +closed: boolean;
}

type Cleanup = ?{ +unsubscribe: () => void } | (() => void);

export type SubscriberFunction<T, E = Error> = (
  observer: ISubscriptionObserver<T, E>
) => Cleanup;

type BaseSubscriberFunction<T, E = Error> = (
  observer: SubscriptionObserver<T, E>
) => Cleanup;

export type Observer<T, E = Error> = {
  +start?: ?(subscription: ISubscription) => void,
  +next?: ?(value: T) => void,
  +error?: ?(errorValue: E) => void,
  +complete?: ?() => void
};

export interface IAdaptsToObservable<T, E = Error> {
  // Flow cannot parse computed properties.
  //[symbolObservable](): IObservable<T, E>
}
export interface IPromiseLike<T> {
  then(onFulfill: ?(value: T) => any, onReject: ?(errorValue: any) => any): any;
}
export type ObservableInput<T, E = Error> =
  | IAdaptsToObservable<T, E>
  | IClassicObservable<T, E>
  | Promise<T>
  | Iterable<T>;

export interface IObservable<T, E = Error> extends IAdaptsToObservable<T, E> {
  subscribe(
    observerOrOnNext: ?Observer<T, E> | ((value: T) => void),
    onError: ?(errorValue: E) => void,
    onComplete: ?() => void
  ): ISubscription;
}

export type OperatorFunction<T, R, E = Error> = (
  EsObservable<T, E>
) => EsObservable<R, E>;

// Functions to be called within tryCatch().

function callNext<T, E>(observer: Observer<T, E>, value: T): void {
  const { next } = observer;
  if (typeof next === "function") {
    next.call(observer, value);
  }
}

function callError<T, E>(observer: Observer<T, E>, errorValue: E): void {
  const { error } = observer;
  if (typeof error === "function") {
    error.call(observer, errorValue);
  }
}

function callComplete<T, E>(observer: Observer<T, E>): void {
  const { complete } = observer;
  if (typeof complete === "function") {
    complete.call(observer);
  }
}

function callStart<T, E>(
  observer: Observer<T, E>,
  subscription: Subscription<T, E>
): void {
  const { start } = observer;
  if (typeof start === "function") {
    start.call(observer, subscription);
  }
}

function callCleanup<T, E>(subscription: Subscription<T, E>) {
  const cleanup = subscription._cleanup;
  if (typeof cleanup === "function") {
    subscription._cleanup = undefined;
    cleanup();
  } else if (typeof cleanup === "object" && cleanup !== null) {
    subscription._cleanup = undefined;
    cleanup.unsubscribe();
  }
}

class SubscriptionObserver<T, E = Error>
  implements ISubscriptionObserver<T, E>, IClassicSubscriptionObserver<T, E> {
  _subscription: Subscription<T, E>;

  constructor(subscription: Subscription<T, E>): void {
    this._subscription = subscription;
  }

  next(value: T): void {
    const subscription = this._subscription;
    const observer = subscription._observer;
    if (typeof observer === "undefined") {
      return;
    }
    tryCatch(callNext, observer, value);
  }

  error(errorValue: E): void {
    const subscription = this._subscription;
    const observer = subscription._observer;
    if (typeof observer === "undefined") {
      return;
    }
    subscription._observer = undefined;
    tryCatch(callError, observer, errorValue);
    tryCatch(callCleanup, subscription);
  }

  complete(): void {
    const subscription = this._subscription;
    const observer = subscription._observer;
    if (typeof observer === "undefined") {
      return;
    }
    subscription._observer = undefined;
    tryCatch(callComplete, observer);
    tryCatch(callCleanup, subscription);
  }

  get closed(): boolean {
    return typeof this._subscription._observer === "undefined";
  }

  onNext(value: T): void {
    this.next(value);
  }
  onError(errorValue: E): void {
    this.error(errorValue);
  }
  onCompleted(): void {
    this.complete();
  }
  get isStopped(): boolean {
    return this.closed;
  }
}

class Subscription<T, E = Error> implements ISubscription, IDisposable {
  _observer: Observer<T, E> | void;
  _cleanup: Cleanup;

  constructor(
    subscriber: BaseSubscriberFunction<T, E>,
    observer: Observer<T, E>
  ): void {
    this._observer = observer;
    tryCatch(callStart, observer, this);
    if (typeof this._observer === "undefined") {
      return;
    }
    const subscriptionObserver = new SubscriptionObserver(this);
    const subscriberResult = tryCatchResult(subscriber, subscriptionObserver);
    if (subscriberResult === symbolError) {
      // XXX implies E must always be Error.
      subscriptionObserver.error((popError(): any));
      return;
    }
    const cleanup: Cleanup = subscriberResult;
    if (cleanup === null || typeof cleanup === "undefined") {
      return;
    }
    if (typeof cleanup !== "function" && typeof cleanup !== "object") {
      throw new TypeError(
        "unexpected subscriber result type " + typeof cleanup
      );
    }
    if (
      typeof cleanup === "object" &&
      typeof cleanup.unsubscribe !== "function"
    ) {
      throw new TypeError("expected unsubscribe property to be a function");
    }
    this._cleanup = cleanup;
    if (typeof this._observer === "undefined") {
      tryCatch(callCleanup, this);
    }
  }

  unsubscribe(): void {
    const observer = this._observer;
    if (typeof observer === "undefined") {
      return;
    }
    this._observer = undefined;
    tryCatch(callCleanup, this);
  }

  get closed(): boolean {
    return typeof this._observer === "undefined";
  }

  dispose(): void {
    this.unsubscribe();
  }
  get isDisposed(): boolean {
    return this.closed;
  }
}

let EsObservable;

class BaseObservable<T, E = Error> implements IAdaptsToObservable<T, E> {
  _subscriber: BaseSubscriberFunction<T, E>;

  constructor(subscriber: BaseSubscriberFunction<T, E>): void {
    if (typeof subscriber !== "function") {
      throw new TypeError("Function expected");
    }
    this._subscriber = subscriber;
  }

  // $FlowFixMe: No symbol or computed property support.
  [symbolObservable](): IObservable<T, E> {
    return new EsObservable(this._subscriber);
  }

  // Flow doesn't support returning a differently parameterized this type so
  // specify types on subclasses instead.
  pipe(...operators: any[]): any {
    return this.constructor.from(
      // $FlowFixMe: No symbol support.
      operators.reduce((acc, curr) => curr(acc), this[symbolObservable]())
    );
  }

  static of(...values: T[]): this {
    return new this(observer => {
      for (const value of values) {
        observer.next(value);
      }
      observer.complete();
    });
  }

  static from(input: ObservableInput<T, E>): this {
    if (typeof input === "undefined" || input === null) {
      throw new TypeError();
    }

    if (typeof input === "object") {
      const observableProp: ?() => IObservable<T, E> =
        // $FlowFixMe: No symbol support.
        input[symbolObservable];
      if (typeof observableProp === "function") {
        const observable = observableProp.call(input);
        if (typeof observable !== "object" || observable === null) {
          throw new TypeError();
        }
        if ((observable: any).constructor === this) {
          return (observable: any);
        }
        // Avoid additional wrapping between compatible observable implementations.
        if (observable instanceof BaseObservable) {
          return new this(observable._subscriber);
        }
        return new this(observer => observable.subscribe(observer));
      }
      if (typeof input.subscribe === "function") {
        // Not part of ES Observable spec
        const classic: IClassicObservable<T, E> = (input: any);
        return new this(observer => {
          const disposable = classic.subscribe(observer);
          return () => disposable.dispose();
        });
      }
      if (typeof input.then === "function") {
        // Not part of ES Observable spec
        const promiseLike: IPromiseLike<T> = (input: any);
        return new this(observer => {
          promiseLike.then(
            value => {
              observer.next(value);
              observer.complete();
            },
            errorValue => {
              observer.error(errorValue);
            }
          );
        });
      }
    }

    // $FlowFixMe: No symbol support.
    if (typeof input[Symbol.iterator] === "function") {
      return new this(observer => {
        // $FlowFixMe: No symbol support.
        for (const value of (input: Iterable<T>)) {
          observer.next(value);
        }
        observer.complete();
      });
    }

    throw new TypeError();
  }

  static fromClassicObservable(classic: IClassicObservable<T, E>): this {
    return this.from(classic);
  }

  static empty(): this {
    return new this(observer => {
      observer.complete();
    });
  }

  static throw(errorValue: E): this {
    return new this(observer => {
      observer.error(errorValue);
    });
  }

  static defer(factory: () => ObservableInput<T, E>): this {
    return new this(observer => {
      const result = factory();
      const obs = this.from(result);
      return new Subscription(obs._subscriber, observer);
    });
  }
}

// eslint-disable-next-line no-shadow
EsObservable = class EsObservable<T, E = Error> extends BaseObservable<T, E>
  implements IObservable<T, E> {
  subscribe(
    observerOrOnNext: ?Observer<T, E> | ((value: T) => void),
    onError: ?(errorValue: E) => void,
    onComplete: ?() => void
  ): ISubscription {
    const observer =
      typeof observerOrOnNext === "object" && observerOrOnNext !== null
        ? observerOrOnNext
        : {
            next: observerOrOnNext,
            error: onError,
            complete: onComplete
          };
    return new Subscription(this._subscriber, observer);
  }

  // $FlowFixMe: No symbol or computed property support.
  [symbolObservable](): this {
    return this;
  }

  // To pass ES Observable tests these static functions must work without this.
  static of(...values: T[]): this {
    const C = typeof this === "function" ? this : (EsObservable: any);
    return super.of.call(C, ...values);
  }

  static from(input: ObservableInput<T, E>): this {
    const C = typeof this === "function" ? this : (EsObservable: any);
    return super.from.call(C, input);
  }

  pipe: (() => EsObservable<T, E>) &
    (<R>(op1: OperatorFunction<T, R, E>) => EsObservable<R, E>) &
    (<R1, R2>(
      op1: OperatorFunction<T, R1, E>,
      op2: OperatorFunction<R1, R2, E>
    ) => EsObservable<R2, E>) &
    (<R1, R2, R3>(
      op1: OperatorFunction<T, R1, E>,
      op2: OperatorFunction<R1, R2, E>,
      op3: OperatorFunction<R2, R3, E>
    ) => EsObservable<R3, E>) &
    (<R1, R2, R3, R4>(
      op1: OperatorFunction<T, R1, E>,
      op2: OperatorFunction<R1, R2, E>,
      op3: OperatorFunction<R2, R3, E>,
      op4: OperatorFunction<R3, R4, E>
    ) => EsObservable<R4, E>) &
    (<R1, R2, R3, R4, R5>(
      op1: OperatorFunction<T, R1, E>,
      op2: OperatorFunction<R1, R2, E>,
      op3: OperatorFunction<R2, R3, E>,
      op4: OperatorFunction<R3, R4, E>,
      op5: OperatorFunction<R4, R5, E>
    ) => EsObservable<R5, E>) &
    (<R1, R2, R3, R4, R5, R6>(
      op1: OperatorFunction<T, R1, E>,
      op2: OperatorFunction<R1, R2, E>,
      op3: OperatorFunction<R2, R3, E>,
      op4: OperatorFunction<R3, R4, E>,
      op5: OperatorFunction<R4, R5, E>,
      op6: OperatorFunction<R5, R6, E>
    ) => EsObservable<R6, E>) &
    (<R1, R2, R3, R4, R5, R6, R7>(
      op1: OperatorFunction<T, R1, E>,
      op2: OperatorFunction<R1, R2, E>,
      op3: OperatorFunction<R2, R3, E>,
      op4: OperatorFunction<R3, R4, E>,
      op5: OperatorFunction<R4, R5, E>,
      op6: OperatorFunction<R5, R6, E>,
      op7: OperatorFunction<R6, R7, E>
    ) => EsObservable<R7, E>) &
    (<R1, R2, R3, R4, R5, R6, R7, R8>(
      op1: OperatorFunction<T, R1, E>,
      op2: OperatorFunction<R1, R2, E>,
      op3: OperatorFunction<R2, R3, E>,
      op4: OperatorFunction<R3, R4, E>,
      op5: OperatorFunction<R4, R5, E>,
      op6: OperatorFunction<R5, R6, E>,
      op7: OperatorFunction<R6, R7, E>,
      op8: OperatorFunction<R7, R8, E>
    ) => EsObservable<R8, E>) &
    (<R1, R2, R3, R4, R5, R6, R7, R8, R9>(
      op1: OperatorFunction<T, R1, E>,
      op2: OperatorFunction<R1, R2, E>,
      op3: OperatorFunction<R2, R3, E>,
      op4: OperatorFunction<R3, R4, E>,
      op5: OperatorFunction<R4, R5, E>,
      op6: OperatorFunction<R5, R6, E>,
      op7: OperatorFunction<R6, R7, E>,
      op8: OperatorFunction<R7, R8, E>,
      op9: OperatorFunction<R8, R9, E>
    ) => EsObservable<R9, E>) &
    (<R1, R2, R3, R4, R5, R6, R7, R8, R9, R10>(
      op1: OperatorFunction<T, R1, E>,
      op2: OperatorFunction<R1, R2, E>,
      op3: OperatorFunction<R2, R3, E>,
      op4: OperatorFunction<R3, R4, E>,
      op5: OperatorFunction<R4, R5, E>,
      op6: OperatorFunction<R5, R6, E>,
      op7: OperatorFunction<R6, R7, E>,
      op8: OperatorFunction<R7, R8, E>,
      op9: OperatorFunction<R8, R9, E>,
      op10: OperatorFunction<R9, R10, E>
    ) => EsObservable<R10, E>) &
    (<R>(...operators: OperatorFunction<T, R, E>[]) => EsObservable<R, E>);
};

module.exports = {
  BaseObservable,
  Observable: EsObservable,
  Subscription
};
