// src/hooks/useHistory.ts
import { useState } from "react";

export function useHistory<T>(initial: T) {
  const [stack, setStack] = useState<T[]>([initial]);
  const [index, setIndex] = useState(0);

  const set = (value: T) => {
    const copy = stack.slice(0, index + 1);
    copy.push(value);
    setStack(copy);
    setIndex(copy.length - 1);
    console.log(value)
  };

  const undo = () => {
    if (index > 0) setIndex((i) => i - 1);
  };

  const redo = () => {
    if (index < stack.length - 1) setIndex((i) => i + 1);
  };

  return {
    state: stack[index],
    set,
    undo,
    redo,
  };
}
