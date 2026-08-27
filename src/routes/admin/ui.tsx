import { Html } from "@elysia/html";
import type { Children as Child } from "@kitajs/html";

// ---------------------------------------------------------------------------
// Form components
// ---------------------------------------------------------------------------

export function Label({ for: htmlFor, children }: { for?: string; children: Child }) {
  return <label for={htmlFor} class="block text-[0.82rem] font-semibold text-gray-700 mb-1.5">{children}</label>;
}

export function Input({ size, ...props }: Record<string, any>) {
  const base = "border border-gray-200 bg-white/90 rounded-xl font-[inherit] text-gray-900 shadow-sm placeholder:text-gray-400 hover:border-gray-300 focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500";
  const sizes: Record<string, string> = {
    sm: "px-3 py-2 text-sm",
    md: "w-full px-3.5 py-2.5 text-sm mb-3",
  };
  const s = sizes[size ?? "md"] ?? sizes.md;
  return <input {...props} class={`${base} ${s} ${props.class ?? ""}`} />;
}

export function Select({ children, size, ...props }: Record<string, any>) {
  const base = "border border-gray-200 bg-white/90 rounded-xl font-[inherit] text-gray-900 shadow-sm hover:border-gray-300 focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500";
  const sizes: Record<string, string> = {
    sm: "px-3 py-2 text-sm",
    md: "w-full px-3.5 py-2.5 text-sm mb-3",
  };
  const s = sizes[size ?? "md"] ?? sizes.md;
  return <select {...props} class={`${base} ${s} ${props.class ?? ""}`}>{children}</select>;
}

export function Textarea(props: Record<string, any>) {
  return <textarea {...props} class={`w-full px-3.5 py-3 border border-gray-200 bg-white/90 rounded-xl text-sm font-[inherit] mb-3 min-h-[200px] resize-y shadow-sm placeholder:text-gray-400 hover:border-gray-300 focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 ${props.class ?? ""}`} />;
}

export function FormGroup({ children }: { children: Child }) {
  return <div class="mb-4">{children}</div>;
}

// ---------------------------------------------------------------------------
// Button components
// ---------------------------------------------------------------------------

export function Button({ children, variant = "primary", size = "md", ...props }: Record<string, any>) {
  const base = "font-semibold cursor-pointer no-underline shadow-sm hover:-translate-y-px active:translate-y-0 disabled:opacity-60 disabled:cursor-wait";
  const sizes = {
    sm: "px-2.5 py-1.5 text-xs rounded-lg",
    md: "px-4 py-2.5 text-sm rounded-xl",
    filter: "px-3.5 py-2 text-sm rounded-xl",
  };
  const variants = {
    primary: "bg-gray-950 text-white hover:bg-blue-600 border border-gray-950 hover:border-blue-600",
    danger: "bg-red-600 text-white hover:bg-red-700 border border-red-600",
    secondary: "bg-white text-gray-700 hover:bg-gray-50 border border-gray-200 hover:border-gray-300",
    ghost: "bg-transparent text-red-600 hover:text-red-800 border-none p-0",
  };
  const s = sizes[size as keyof typeof sizes] ?? sizes.md;
  const v = variants[variant as keyof typeof variants] ?? variants.primary;
  return <button hx-disabled-elt="this" {...props} class={`inline-flex items-center justify-center gap-2 ${base} ${s} ${v} ${props.class ?? ""}`}>{children}</button>;
}

export function LinkButton({ href, children, variant = "primary", size = "md", ...props }: Record<string, any>) {
  const base = "inline-flex items-center justify-center gap-2 font-semibold cursor-pointer no-underline shadow-sm hover:-translate-y-px active:translate-y-0";
  const sizes: Record<string, string> = {
    sm: "px-2.5 py-1.5 text-xs rounded-lg",
    md: "px-4 py-2.5 text-sm rounded-xl",
  };
  const variants: Record<string, string> = {
    primary: "bg-gray-950 text-white hover:bg-blue-600",
    danger: "bg-red-600 text-white hover:bg-red-700",
    secondary: "bg-white text-gray-700 hover:bg-gray-50 border border-gray-300",
  };
  const s = sizes[size as string] ?? sizes.md;
  const v = variants[variant as string] ?? variants.primary;
  return <a href={href} {...props} class={`${base} ${s} ${v} ${props.class ?? ""}`}>{children}</a>;
}

// ---------------------------------------------------------------------------
// Table components
// ---------------------------------------------------------------------------

export function Table({ children }: { children: Child }) {
  return <div class="app-surface rounded-2xl overflow-x-auto mb-6"><table class="w-full min-w-[38rem] text-sm">{children}</table></div>;
}

export function Th({ children }: { children?: Child }) {
  return <th class="bg-gray-50/80 px-5 py-3.5 text-left text-[0.68rem] font-bold uppercase tracking-[0.12em] text-gray-500 border-b border-gray-200">{children}</th>;
}

export function Td({ children, class: cls, colspan }: { children?: Child; class?: string; colspan?: number }) {
  return <td colspan={colspan} class={`px-5 py-4 border-b border-gray-100 ${cls ?? ""}`}>{children}</td>;
}

// ---------------------------------------------------------------------------
// Layout components
// ---------------------------------------------------------------------------

export function Card({ children, class: cls }: { children: Child; class?: string }) {
  return <div class={`app-surface rounded-2xl p-5 sm:p-6 mb-6 ${cls ?? ""}`}>{children}</div>;
}

export function PageHeader({ title, children }: { title: string; children?: Child }) {
  return (
    <div class="flex items-center justify-between gap-4 mb-7">
      <div><p class="text-[0.68rem] font-bold uppercase tracking-[0.18em] text-blue-600 mb-1">Workspace</p><h1 class="text-2xl sm:text-3xl font-bold tracking-tight mt-0 mb-0 text-gray-950">{title}</h1></div>
      {children}
    </div>
  );
}
