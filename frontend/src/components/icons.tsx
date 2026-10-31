import type { ReactNode, SVGProps } from "react";

type IconProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, "children">;

function make(paths: ReactNode) {
  return function Icon({ size = 18, ...rest }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
        {paths}
      </svg>
    );
  };
}

export const Menu = make(<><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>);
export const Chat = make(<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />);
export const Plus = make(<><path d="M12 5v14" /><path d="M5 12h14" /></>);
export const Send = make(<><path d="M4 12 20 4l-6 16-3-7-7-1z" /></>);
export const Play = make(<path d="M8 5.5v13l10-6.5-10-6.5z" />);
export const Stop = make(<rect x="7" y="7" width="10" height="10" rx="1.5" />);
export const Chevron = make(<path d="m7 10 5 5 5-5" />);
export const ChevronLeft = make(<path d="m14 7-5 5 5 5" />);
export const ChevronRight = make(<path d="m10 7 5 5-5 5" />);
export const Close = make(<><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>);
export const Check = make(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const Alert = make(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5.5" /><path d="M12 16.3v.2" /></>);
export const Info = make(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5" /><path d="M12 7.7v.2" /></>);
export const Reset = make(<><path d="M5 12a7 7 0 1 0 2.1-5" /><path d="M5 4.5V8h3.5" /></>);
export const Doc = make(<><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5z" /><path d="M14 3.5V8h4" /><path d="M9.5 12h5" /><path d="M9.5 15.5h5" /></>);
export const Table = make(<><rect x="4" y="5" width="16" height="14" rx="1.5" /><path d="M4 10h16" /><path d="M10 10v9" /></>);
export const Shield = make(<><path d="M12 3.5 19 6v5.5c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6l7-2.5z" /><path d="m9 12 2.2 2.2L15.5 10" /></>);
export const List = make(<><path d="M9 7h11" /><path d="M9 12h11" /><path d="M9 17h11" /><path d="M4.5 7h.01" /><path d="M4.5 12h.01" /><path d="M4.5 17h.01" /></>);
export const Paperclip = make(<path d="M8.5 12.5 14 7a3 3 0 0 1 4.2 4.2l-7.1 7.1a5 5 0 0 1-7.1-7.1L10.6 4.6" />);
export const Plug = make(<><path d="M9 3.5V8" /><path d="M15 3.5V8" /><path d="M7 8h10v3a5 5 0 0 1-10 0V8z" /><path d="M12 16v4.5" /></>);
export const Download = make(<><path d="M12 4v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M5 19.5h14" /></>);
export const Retry = make(<><path d="M19 12a7 7 0 1 1-2.1-5" /><path d="M19 4.5V8h-3.5" /></>);
export const Branch = make(<><circle cx="7" cy="6" r="2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="8" r="2" /><path d="M7 8v8" /><path d="M17 10c0 4-10 2-10 6" /></>);
