/*
 * Protocol code any driver may use, handed to every driver's create() as
 * `lib` — so a driver installed in the data folder, which cannot import from
 * the app by path, gets the same building blocks the built-in ones use.
 */

import * as osc from './osc.js';
import * as hyperdeckProtocol from './hyperdeck/protocol.js';
import { DeckLink } from './hyperdeck/link.js';

export const lib = Object.freeze({
  osc,                                              // encode(address, args), decode(buf)
  hyperdeck: { DeckLink, ...hyperdeckProtocol },    // a kept-up HyperDeck link and its parser
});
