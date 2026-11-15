import type { AnchorHTMLAttributes, KeyboardEvent, MouseEvent } from "react";

/**
 * An action shown as a link. Unlike a bare `<a onClick>`, it can be reached with Tab and
 * triggered with Enter or Space: these call `onActivate` when the link has no `onClick`
 * (a link that reacts to the pointer going down, to be dragged).
 */
export function LinkButton({
  onClick,
  onActivate,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { onActivate?: () => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    if (onClick) onClick(e as unknown as MouseEvent<HTMLAnchorElement>);
    else onActivate?.();
  };
  return (
    <a role="button" tabIndex={0} {...rest} onClick={onClick} onKeyDown={onKeyDown}>
      {children}
    </a>
  );
}
