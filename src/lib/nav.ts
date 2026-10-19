/** Counts in-app client navigations so "back" links can use history only when it stays in the app. */
let count = -1;
export const noteNavigation = () => { count += 1; };
export const hasInAppHistory = () => count > 0;
