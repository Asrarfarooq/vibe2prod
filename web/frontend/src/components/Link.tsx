import { useCallback, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { navigate } from "../lib/router";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

export function Link({ to, onClick, ...rest }: LinkProps) {
  const handle = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to);
    },
    [onClick, to],
  );
  return <a href={to} onClick={handle} {...rest} />;
}
