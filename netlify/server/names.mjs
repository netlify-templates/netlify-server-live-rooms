// The board's names for its clients. The server names every client from its
// id, the same way on every instance, so a name stays put across reconnects
// and nobody can show everyone else a name of their own choosing.
import { createHash } from "node:crypto";

const ADJECTIVES = ["Sunny", "Brave", "Quiet", "Swift", "Lucky", "Merry", "Clever", "Gentle", "Jolly", "Calm", "Bold", "Bright", "Cosy", "Keen", "Plucky", "Witty"];
const ANIMALS = ["Otter", "Heron", "Lynx", "Gecko", "Puffin", "Ibex", "Koala", "Marten", "Newt", "Quokka", "Badger", "Wren", "Seal", "Fox", "Panda", "Owl"];

export const nameOf = (client) => {
  const [a, b] = createHash("sha256").update(client).digest();

  return `${ADJECTIVES[a % ADJECTIVES.length]} ${ANIMALS[b % ANIMALS.length]}`;
};
