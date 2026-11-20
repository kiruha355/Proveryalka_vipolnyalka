import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { MessageText } from "./MessageText";

it("shows provider code as an escaped code block and keeps inline context", () => {
  const { container } = render(<MessageText text={'Guard `execute`:\n```python\nif not cancelled:\n    execute()\n```\n**Условие** сохраняется.'} />);
  expect(container.querySelector("pre code")?.textContent).toBe("if not cancelled:\n    execute()");
  expect(screen.getByText("execute", { selector: "code" })).toBeInTheDocument();
  expect(screen.getByText("Условие", { selector: "strong" })).toBeInTheDocument();
  expect(container.textContent).not.toContain("```");
});

it("never interprets provider HTML or loads embedded content", () => {
  const { container } = render(<MessageText text={'<img src="https://untrusted.invalid/pixel" onerror="alert(1)">\n```html\n<script>alert(1)</script>'} />);
  expect(container.querySelector("img,script,iframe")).toBeNull();
  expect(container.querySelector("pre code")?.textContent).toBe("<script>alert(1)</script>");
  expect(container.textContent).toContain('<img src="https://untrusted.invalid/pixel"');
});
