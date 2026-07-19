export function formatLinearCategoryLabel(category: string): string {
  switch (category) {
    case "unstarted":
      return "Unstarted";
    case "started":
      return "Started";
    case "backlog":
      return "Backlog";
    case "completed":
      return "Completed";
    case "canceled":
      return "Canceled";
    case "duplicate":
      return "Duplicate";
    default:
      return category;
  }
}
