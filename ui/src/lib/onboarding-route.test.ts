import { describe, expect, it } from "vitest";
import {
  canGoBackFromOnboardingStep,
  canJumpToOnboardingStep,
  EXISTING_COMPANY_ONBOARDING_STEP,
  isOnboardingPath,
  isOnboardingWizardActive,
  resolveRouteOnboardingOptions,
  shouldRedirectCompanylessRouteToOnboarding,
} from "./onboarding-route";

describe("isOnboardingPath", () => {
  it("matches the global onboarding route", () => {
    expect(isOnboardingPath("/onboarding")).toBe(true);
  });

  it("matches a company-prefixed onboarding route", () => {
    expect(isOnboardingPath("/pap/onboarding")).toBe(true);
  });

  it("ignores non-onboarding routes", () => {
    expect(isOnboardingPath("/pap/dashboard")).toBe(false);
  });
});

describe("resolveRouteOnboardingOptions", () => {
  it("opens company creation for the global onboarding route", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/onboarding",
        companies: [],
      }),
    ).toEqual({ initialStep: 1 });
  });

  it("opens agent creation when the prefixed company exists", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding",
        companyPrefix: "pap",
        companies: [{ id: "company-1", issuePrefix: "PAP" }],
      }),
    ).toEqual({ initialStep: 3, companyId: "company-1" });
  });

  // A matched prefix used to land on step 2 ("Define your mission"), which was
  // a hard dead-end — nothing prefilled the company name, "Confirm mission"
  // gates on it, and the Back button is hidden at the entry step.
  it("never lands an existing company on the name or mission steps", () => {
    const resolved = resolveRouteOnboardingOptions({
      pathname: "/pap/onboarding",
      companyPrefix: "pap",
      companies: [{ id: "company-1", issuePrefix: "PAP" }],
    });

    expect(resolved?.initialStep).toBe(EXISTING_COMPANY_ONBOARDING_STEP);
    expect(resolved?.initialStep).toBeGreaterThan(2);
  });

  it("falls back to company creation when the prefixed company is missing", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding",
        companyPrefix: "pap",
        companies: [],
      }),
    ).toEqual({ initialStep: 1 });
  });
});

describe("onboarding step navigation bounds", () => {
  const entryStep = EXISTING_COMPANY_ONBOARDING_STEP;

  it("offers Back once a run has moved past its entry step", () => {
    expect(canGoBackFromOnboardingStep({ currentStep: 4, entryStep })).toBe(true);
  });

  it("withholds Back on the entry step itself", () => {
    expect(canGoBackFromOnboardingStep({ currentStep: entryStep, entryStep })).toBe(
      false,
    );
  });

  it("withholds Back on the first step of a fresh run", () => {
    expect(canGoBackFromOnboardingStep({ currentStep: 1, entryStep: 0 })).toBe(false);
  });

  // The progress bar only checked "already completed", so a run entered on an
  // existing company could still click its way to the name and mission steps
  // that Back deliberately withholds — and step 2 was a trap (empty company
  // name, permanently disabled "Confirm mission", no Back).
  it("does not let an existing-company run jump to the name or mission steps", () => {
    expect(canJumpToOnboardingStep({ targetStep: 1, currentStep: 5, entryStep })).toBe(
      false,
    );
    expect(canJumpToOnboardingStep({ targetStep: 2, currentStep: 5, entryStep })).toBe(
      false,
    );
  });

  it("still lets an existing-company run jump back to completed later steps", () => {
    expect(canJumpToOnboardingStep({ targetStep: 3, currentStep: 5, entryStep })).toBe(
      true,
    );
    expect(canJumpToOnboardingStep({ targetStep: 4, currentStep: 5, entryStep })).toBe(
      true,
    );
  });

  it("leaves a fresh run able to jump back to every completed step", () => {
    expect(canJumpToOnboardingStep({ targetStep: 1, currentStep: 3, entryStep: 0 })).toBe(
      true,
    );
    expect(canJumpToOnboardingStep({ targetStep: 2, currentStep: 3, entryStep: 0 })).toBe(
      true,
    );
  });

  it("never offers a jump to the current or an unreached step", () => {
    expect(canJumpToOnboardingStep({ targetStep: 3, currentStep: 3, entryStep: 0 })).toBe(
      false,
    );
    expect(canJumpToOnboardingStep({ targetStep: 4, currentStep: 3, entryStep: 0 })).toBe(
      false,
    );
  });

  it("agrees with the Back button wherever both are offered", () => {
    for (let currentStep = 1; currentStep <= 5; currentStep += 1) {
      for (const entry of [0, 1, EXISTING_COMPANY_ONBOARDING_STEP]) {
        const back = canGoBackFromOnboardingStep({ currentStep, entryStep: entry });
        const jump = canJumpToOnboardingStep({
          targetStep: currentStep - 1,
          currentStep,
          entryStep: entry,
        });
        // Back walks to currentStep - 1, so it may only be offered where that
        // same step is a legal jump target.
        expect(back && !jump).toBe(false);
      }
    }
  });
});

describe("shouldRedirectCompanylessRouteToOnboarding", () => {
  it("redirects companyless entry routes into onboarding", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/",
        hasCompanies: false,
      }),
    ).toBe(true);
  });

  it("does not redirect when already on onboarding", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/onboarding",
        hasCompanies: false,
      }),
    ).toBe(false);
  });

  it("does not redirect when companies exist", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/issues",
        hasCompanies: true,
      }),
    ).toBe(false);
  });
});

describe("isOnboardingWizardActive", () => {
  it("is active on the freshly-landed onboarding route (auto-open, not dismissed)", () => {
    expect(
      isOnboardingWizardActive({ onboardingOpen: false, routeDismissed: false }),
    ).toBe(true);
  });

  it("hands off to the launcher once the wizard is dismissed and not re-opened", () => {
    expect(
      isOnboardingWizardActive({ onboardingOpen: false, routeDismissed: true }),
    ).toBe(false);
  });

  it("stays active when explicitly re-opened after a dismissal", () => {
    expect(
      isOnboardingWizardActive({ onboardingOpen: true, routeDismissed: true }),
    ).toBe(true);
  });
});
