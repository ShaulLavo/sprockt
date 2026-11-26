// Whether the document in the preview frame takes the pane's commands (bridge.ts). Only a page
// that runs our client script does; an image, a download, a refusal from the service worker or
// a page of another charset does not, and the frame has to be steered by its address instead.
//
// The pane does not guess this from the order in which a page's messages and the frame's load
// event arrive, which differs between browsers. It asks: every time a document finishes
// loading it sends a numbered `hello`, and only an answer with that number means "this
// document understands". A document that says nothing is steered by its address.
export interface Greeting {
  /** A new document is in the frame (or the frame is new): the number to greet it with. */
  ask(): number;
  /** The frame answered a greeting. An answer to an earlier one says nothing about this document. */
  answer(id: number): void;
  /** Whether the document that is in the frame now has answered. */
  readonly understood: boolean;
}

export function createGreeting(): Greeting {
  let asked = 0;
  let answered = -1;
  return {
    ask() {
      asked += 1;
      return asked;
    },
    answer(id) {
      if (id === asked) answered = id;
    },
    get understood() {
      return answered === asked;
    },
  };
}
