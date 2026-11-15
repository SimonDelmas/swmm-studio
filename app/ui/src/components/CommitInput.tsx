import type { InputHTMLAttributes } from "react";

/**
 * A text field whose value is applied when it is left or Enter is pressed, not on every
 * key. It shows `value` again whenever that changes (also when what was typed is refused).
 */
export function CommitInput({
  value,
  onCommit,
  ...rest
}: { value: string | number; onCommit: (text: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onBlur">) {
  return (
    <input
      {...rest}
      key={String(value)}
      defaultValue={value}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        rest.onKeyDown?.(e);
      }}
    />
  );
}

/** A [`CommitInput`] for a number, with a decimal point or comma; what is not a number is ignored. */
export function NumberInput({ onCommit, ...rest }: { value: number; onCommit: (v: number) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onBlur">) {
  return (
    <CommitInput
      {...rest}
      onCommit={(text) => {
        const v = Number(text.trim().replace(",", "."));
        if (text.trim() !== "" && Number.isFinite(v)) onCommit(v);
      }}
    />
  );
}
