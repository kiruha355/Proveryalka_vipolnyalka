import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({
  size = 16,
  children,
  ...rest
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const MinusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14" />
  </Icon>
);
export const FitIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Icon>
);
export const ExpandIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M4 4l5 5M20 4l-5 5M4 20l5-5M20 20l-5-5" />
  </Icon>
);
export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const BackIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M15 6l-6 6 6 6" />
  </Icon>
);
export const StepIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 5l10 7-10 7z" />
  </Icon>
);
export const ResetIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 12a8 8 0 1 0 2.4-5.7" />
    <path d="M4 4v5h5" />
  </Icon>
);
export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.5v.01" />
  </Icon>
);
export const BlockedIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8" />
    <path d="M6.5 6.5l11 11" />
  </Icon>
);
export const ListIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
  </Icon>
);
export const GraphIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="6" height="5" rx="1.2" />
    <rect x="15" y="4" width="6" height="5" rx="1.2" />
    <rect x="9" y="15" width="6" height="5" rx="1.2" />
    <path d="M9 6.5h6M6 9v3.5h6V15M18 9v3.5h-6" />
  </Icon>
);
export const PencilIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </Icon>
);
export const FolderIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  </Icon>
);
export const FileIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z" />
    <path d="M14 3v4.5h4.5" />
  </Icon>
);
export const ChevronIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);
export const DownloadIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Icon>
);
export const LinkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Icon>
);
export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
  </Icon>
);
