import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AccountForm } from "./AccountForm";

it("focuses the first invalid field after submit and lets the user correct another field", async () => {
  const keyboard = userEvent.setup();
  const submit = vi.fn();
  render(<AccountForm mode="login" onSubmit={submit} initialEmail="bad-address" />);
  const email = screen.getByLabelText("Электронная почта");
  const password = screen.getByLabelText("Пароль");
  expect(email).toHaveFocus();
  await keyboard.keyboard("{Enter}");
  expect(email).toHaveAccessibleDescription("Введите корректный адрес почты.");
  expect(password).toHaveAttribute("aria-invalid", "true");

  await keyboard.tab();
  expect(password).toHaveFocus();
  await keyboard.keyboard("A password for tests");
  expect(password).toHaveValue("A password for tests");
  expect(password).toHaveFocus();
  expect(email).toHaveAttribute("aria-invalid", "true");
  expect(submit).not.toHaveBeenCalled();
});
