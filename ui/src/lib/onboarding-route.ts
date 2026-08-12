type OnboardingRouteCompany = {
  id: string;
  issuePrefix: string;
};

export function isOnboardingPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 1) {
    return segments[0]?.toLowerCase() === "onboarding";
  }

  if (segments.length === 2) {
    return segments[1]?.toLowerCase() === "onboarding";
  }

  return false;
}

/**
 * The wizard step an already-existing company enters onboarding on: "Create
 * your first agent".
 *
 * A company reached through /{prefix}/onboarding is already named and already
 * has a mission, so step 1 (Name your company) and step 2 (Define your
 * mission) do not apply — the managed path never re-asks for the mission.
 * Entering on step 2 was a hard dead-end instead: nothing prefilled the company
 * name, "Confirm mission" gates on it, and no Back button renders at the entry
 * step.
 */
export const EXISTING_COMPANY_ONBOARDING_STEP = 3;

export function resolveRouteOnboardingOptions(params: {
  pathname: string;
  companyPrefix?: string;
  companies: OnboardingRouteCompany[];
}): { initialStep: 1 | 3; companyId?: string } | null {
  const { pathname, companyPrefix, companies } = params;

  if (!isOnboardingPath(pathname)) return null;

  if (!companyPrefix) {
    return { initialStep: 1 };
  }

  const matchedCompany =
    companies.find(
      (company) =>
        company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase(),
    ) ?? null;

  if (!matchedCompany) {
    return { initialStep: 1 };
  }

  return {
    initialStep: EXISTING_COMPANY_ONBOARDING_STEP,
    companyId: matchedCompany.id,
  };
}

/**
 * Whether the wizard's Back button is offered on the current step.
 *
 * A run never walks back behind the step it entered on: those steps either do
 * not apply to it (an existing company is already named, and its mission is
 * never re-asked) or were already completed elsewhere.
 */
export function canGoBackFromOnboardingStep(params: {
  currentStep: number;
  entryStep: number;
}): boolean {
  return params.currentStep > 1 && params.currentStep > params.entryStep;
}

/**
 * Whether a completed progress-bar segment can be clicked to jump back to it.
 *
 * Same bound as {@link canGoBackFromOnboardingStep}. The progress bar used to
 * apply only the "already completed" half of the rule, which let a run entered
 * on an existing company jump to the name and mission steps the Back button
 * deliberately withholds — the dead-end this guard closes.
 */
export function canJumpToOnboardingStep(params: {
  targetStep: number;
  currentStep: number;
  entryStep: number;
}): boolean {
  return (
    params.targetStep < params.currentStep && params.targetStep >= params.entryStep
  );
}

export function shouldRedirectCompanylessRouteToOnboarding(params: {
  pathname: string;
  hasCompanies: boolean;
}): boolean {
  return !params.hasCompanies && !isOnboardingPath(params.pathname);
}

/**
 * Whether the onboarding wizard is currently covering the screen — either
 * opened explicitly via the dialog context or auto-opened from the
 * /onboarding route and not yet dismissed. While this is true the route
 * launcher must not render interactive content, so it hands off fully to the
 * full-screen wizard instead of staying clickable/focusable behind it
 * (PAP-52).
 */
export function isOnboardingWizardActive(params: {
  onboardingOpen: boolean;
  routeDismissed: boolean;
}): boolean {
  return params.onboardingOpen || !params.routeDismissed;
}
