import * as C from "@effect-ts/core/Collections/Immutable/Chunk"
import * as T from "@effect-ts/core/Effect"
import * as M from "@effect-ts/core/Effect/Managed"
import * as S from "@effect-ts/core/Effect/Stream"
import * as Push from "@effect-ts/core/Effect/Stream/Push"
import * as Sink from "@effect-ts/core/Effect/Stream/Sink"
import { pipe, tuple } from "@effect-ts/core/Function"
import * as O from "@effect-ts/core/Option"
import type * as stream from "stream"

import type { Byte } from "../Byte"
import { buffer } from "../Byte"

export class ReadableError {
  readonly _tag = "ReadableError"
  constructor(readonly error: Error) {}
}

/**
 * Captures a Node `Readable`, converting it into a `Stream`,
 *
 * Note: your Readable should not have an encoding set in order to work with buffers,
 * calling this with a Readable with an encoding setted with `Die`.
 */
export function streamFromReadable(
  r: () => stream.Readable
): S.Stream<unknown, ReadableError, Byte> {
  return pipe(
    T.effectTotal(r),
    T.tap((sr) =>
      sr.readableEncoding != null
        ? T.dieMessage(
            `stream.Readable encoding set to ${sr.readableEncoding} cannot be used to produce Buffer`
          )
        : T.unit
    ),
    S.bracket((sr) =>
      T.effectTotal(() => {
        sr.destroy()
      })
    ),
    S.chain((sr) =>
      S.effectAsync<unknown, ReadableError, Byte>((cb) => {
        sr.on("data", (data) => {
          cb(T.succeed(C.array(data)))
        })
        sr.on("end", () => {
          cb(T.fail(O.none))
        })
        sr.on("error", (err) => {
          cb(T.fail(O.some(new ReadableError(err))))
        })
      })
    )
  )
}

export class WritableError {
  readonly _tag = "WritableError"
  constructor(readonly error: Error) {}
}

/**
 * Captures a Node `Writable`, converting it into a `Sink`
 */
export function sinkFromWritable(
  w: () => stream.Writable
): Sink.Sink<unknown, WritableError, Byte, never, void> {
  return new Sink.Sink(
    pipe(
      T.effectTotal(w),
      M.makeExit((sw) =>
        T.effectTotal(() => {
          sw.destroy()
        })
      ),
      M.map((sw) => (o: O.Option<C.Chunk<Byte>>) =>
        O.isNone(o)
          ? Push.emit(undefined, C.empty())
          : T.effectAsync((cb) => {
              sw.write(o.value, (err) => {
                if (err) {
                  cb(Push.fail(new WritableError(err), C.empty()))
                } else {
                  cb(Push.more)
                }
              })
            })
      )
    )
  )
}

export class TransformError {
  readonly _tag = "TransformError"
  constructor(readonly error: Error) {}
}

/**
 * Captures a Node `Transform` for use with `Stream`
 */
export function transform(
  tr: () => stream.Transform
): <R, E>(stream: S.Stream<R, E, Byte>) => S.Stream<R, E | TransformError, Byte> {
  return <R, E>(stream: S.Stream<R, E, Byte>) => {
    const managedSink = pipe(
      T.effectTotal(tr),
      M.makeExit((st) =>
        T.effectTotal(() => {
          st.destroy()
        })
      ),
      M.map((st) =>
        tuple(
          st,
          Sink.fromPush<unknown, TransformError, Byte, never, void>(
            O.fold(
              () =>
                T.chain_(
                  T.effectTotal(() => {
                    st.end()
                  }),
                  () => Push.emit(undefined, C.empty())
                ),
              (chunk) =>
                T.effectAsync((cb) => {
                  st.write(
                    Buffer.isBuffer(chunk) ? chunk : Buffer.of(...chunk),
                    (err) =>
                      err
                        ? cb(Push.fail(new TransformError(err), C.empty()))
                        : cb(Push.more)
                  )
                })
            )
          )
        )
      )
    )
    return pipe(
      S.managed(managedSink),
      S.chain(([st, sink]) =>
        S.effectAsyncM<unknown, TransformError, Byte, R, E | TransformError>((cb) =>
          T.andThen_(
            T.effectTotal(() => {
              st.on("data", (chunk) => {
                cb(T.succeed(C.array(chunk)))
              })
              st.on("error", (err) => {
                cb(T.fail(O.some(new TransformError(err))))
              })
              st.on("end", () => {
                cb(T.fail(O.none))
              })
            }),
            S.run_(stream, sink)
          )
        )
      )
    )
  }
}

/**
 * A sink that collects all of its inputs into an array.
 */
export function collectBuffer(): Sink.Sink<unknown, never, Byte, never, Buffer> {
  return Sink.map_(
    Sink.reduceLeftChunks(C.empty<Byte>())((s, i: C.Chunk<Byte>) => C.concat_(s, i)),
    buffer
  )
}

/**
 * Runs the stream and collects all of its elements to a buffer.
 */
export function runBuffer<R, E>(self: S.Stream<R, E, Byte>): T.Effect<R, E, Buffer> {
  return S.run_(self, collectBuffer())
}
