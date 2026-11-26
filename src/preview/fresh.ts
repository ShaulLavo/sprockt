// Answers that are never older than the question. Whether mounted previews may be served is
// decided by asking the deploy, and no earlier answer is trusted: every caller gets the answer
// to a question that was asked after it called. Callers that arrive while a question is out
// wait for it and then share the next one, so there is one question out at a time.

/** `ask` must not reject: an answer that cannot be had is an answer too (a "no"). */
export function freshly<T>(ask: () => Promise<T>): () => Promise<T> {
  let asking: Promise<T> | undefined;
  let next: Promise<T> | undefined;

  function start(): Promise<T> {
    const question = ask();
    asking = question;
    const forget = (): void => {
      if (asking === question) asking = undefined;
    };
    question.then(forget, forget);
    return question;
  }

  return () => {
    if (!asking) return start();
    // The question that is out was asked before this caller came: its answer is not theirs.
    next ??= asking.then(() => {
      next = undefined;
      return start();
    });
    return next;
  };
}
