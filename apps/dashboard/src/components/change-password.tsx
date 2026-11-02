import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import { PasswordUpdateForm } from "./password-update-form";

export function ChangePassword() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Confirm your current password to choose a new one.
        </CardDescription>
      </CardHeader>
      <CardContent className="max-w-md">
        <PasswordUpdateForm mode="change" />
      </CardContent>
    </Card>
  );
}
