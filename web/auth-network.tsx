const connections = [
  "M150 78H172Q190 78 190 96V118Q190 136 210 136H230",
  "M150 197H172Q190 197 190 179V154Q190 136 210 136H230",
  "M278 136H300Q318 136 318 118V106Q318 88 336 88H344",
];

/** Illustrative content only; this does not display connection or account state. */
export function AuthNetwork() {
  return (
    <figure className="auth-network">
      <svg
        className="auth-network-scene"
        viewBox="0 0 560 268"
        role="img"
        aria-labelledby="auth-network-title auth-network-description"
      >
        <title id="auth-network-title">
          Your repositories, in the conversation
        </title>
        <desc id="auth-network-description">
          Example GitHub repositories connect through RepoDesk to a Telegram
          topic, where your team asks about changes and receives a summary.
        </desc>
        <g className="network-connections" fill="none">
          {connections.map((d, index) => (
            <g key={d}>
              <path d={d} />
              <path
                className={`network-signal network-signal-${index}`}
                pathLength="100"
                d={d}
              />
            </g>
          ))}
        </g>
        <text className="network-caption" x="0" y="15">
          GITHUB
        </text>
        {[
          { name: "web-app", y: 34 },
          { name: "api-service", y: 153 },
        ].map(({ name, y }) => (
          <g key={name} transform={`translate(0 ${y})`}>
            <rect
              className="network-card"
              x="1"
              y="1"
              width="149"
              height="86"
              rx="12"
            />
            <g
              className="network-repo-icon"
              transform="translate(14 17)"
              fill="none"
            >
              <rect width="14" height="17" rx="2" />
              <path d="M4 0v17M8 5h3M8 9h3" />
            </g>
            <text className="network-repo-name" x="38" y="31">
              {name}
            </text>
            <path
              className="network-branch"
              d="M19 51v15m0-7c10 0 10-1 10-8"
              fill="none"
            />
            <g className="network-branch-dots">
              <circle cx="19" cy="51" r="2" />
              <circle cx="19" cy="66" r="2" />
              <circle cx="29" cy="51" r="2" />
            </g>
            <text className="network-secondary" x="40" y="64">
              main
            </text>
            <path className="network-code-lines" d="M91 55h23m-23 8h37" />
            <circle className="network-port" cx="150" cy="44" r="3" />
          </g>
        ))}
        <g transform="translate(230 112)">
          <rect
            className="network-hub-halo"
            x="-7"
            y="-7"
            width="62"
            height="62"
            rx="20"
          />
          <rect className="network-hub" width="48" height="48" rx="14" />
          <image
            href="/assets/repodesk-mark.svg"
            x="8"
            y="8"
            width="32"
            height="32"
          />
        </g>
        <text className="network-hub-label" x="254" y="186" textAnchor="middle">
          RepoDesk
        </text>
        <g transform="translate(344 15)">
          <rect
            className="network-chat"
            x="0.5"
            y="0.5"
            width="214"
            height="237"
            rx="16"
          />
          <circle className="network-telegram-icon" cx="25" cy="27" r="13" />
          <path
            className="network-plane"
            d="m33 20-18 7 7 2 8-6-6 8 4 4 5-15Z"
            fill="none"
          />
          <text className="network-chat-title" x="47" y="32">
            Telegram
          </text>
          <circle className="network-window-dot" cx="186" cy="27" r="2" />
          <circle className="network-window-dot" cx="194" cy="27" r="2" />
          <path className="network-divider" d="M1 49h213" />
          <rect
            className="network-topic"
            x="13"
            y="60"
            width="188"
            height="27"
            rx="7"
          />
          <text className="network-topic-name" x="24" y="78">
            # release-planning
          </text>
          <g className="network-question">
            <rect
              className="network-question-bubble"
              x="36"
              y="101"
              width="165"
              height="34"
              rx="10"
            />
            <text className="network-message" x="47" y="123">
              What changed today?
            </text>
          </g>
          <g className="network-answer">
            <rect
              className="network-answer-bubble"
              x="13"
              y="145"
              width="188"
              height="60"
              rx="10"
            />
            <text className="network-answer-title" x="24" y="165">
              Here’s the latest.
            </text>
            <text className="network-answer-detail" x="24" y="187">
              2 repos · one conversation
            </text>
          </g>
          <g transform="translate(23 222)">
            <circle className="network-avatar" r="7" />
            <circle
              className="network-avatar network-avatar-second"
              cx="11"
              r="7"
            />
            <circle
              className="network-avatar network-avatar-third"
              cx="22"
              r="7"
            />
            <text className="network-team" x="37" y="4">
              Your team
            </text>
            <g className="network-typing">
              <circle cx="156" r="2" />
              <circle cx="163" r="2" />
              <circle cx="170" r="2" />
            </g>
          </g>
          <circle className="network-port" cx="0" cy="73" r="3" />
        </g>
      </svg>
    </figure>
  );
}
