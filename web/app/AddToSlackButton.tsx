// Official "Add to Slack" button. Points at our own /api/slack/install
// route (not the raw slack.com/authorize URL) so the redirect_uri is set
// to this origin's callback and the requested scopes stay in sync.
export default function AddToSlackButton({ className }: { className?: string }) {
  return (
    <a href="/api/slack/install" aria-label="Add SE3K to Slack" className={className}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt="Add to Slack"
        height={40}
        width={139}
        src="https://platform.slack-edge.com/img/add_to_slack.png"
        srcSet="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"
      />
    </a>
  );
}
