import type { AnchorHTMLAttributes, KeyboardEvent, MouseEvent } from "react";

/**
 * An action shown as a link. Unlike a bare `<a onClick>`, it can be reached with Tab and
 * triggered with Enter or Space.
 */
export function LinkButton({ onClick, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const onKeyDown = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    onClick?.(e as unknown as MouseEvent<HTMLAnchorElement>);
  };
  return (
    <a role="button" tabIndex={0} {...rest} onClick={onClick} onKeyDown={onKeyDown}>
      {children}
    </a>
  );
}
