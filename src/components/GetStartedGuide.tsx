"use client";

interface Props {
  onNavigate: (mode: string, id?: string, name?: string) => void;
}

export default function GetStartedGuide({ onNavigate }: Props) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">Get Started</h1>
      <p className="text-gray-600 mb-8">
        history-md は、日々の記録・アイデア・タスクをブロック単位で管理する軽量ノートアプリです。
        <br />
        ここでは基本的な使い方を紹介します。
      </p>

      {/* 基本フロー */}
      <Section title="基本の使い方フロー">
        <div className="space-y-4">
          <Step number={1} title="日付ページにメモを書く">
            <p>
              サイドバーの<strong>「今日」</strong>をクリックすると、今日の日付ページが開きます。
              ブロック（行）をクリックして、思いついたことをそのまま書き始めましょう。
            </p>
            <Tip>Enter で新しい行、Tab でインデント、Shift+Tab でインデント解除</Tip>
          </Step>
          <Step number={2} title="ページを作って整理する">
            <p>
              サイドバーの<strong>「ページ」</strong>の横にある <Code>+</Code> ボタンで新しいページを作成できます。
              プロジェクトやテーマごとにページを分けると整理しやすくなります。
            </p>
            <Tip>ページは階層化できます。ページ名の横の <Code>+</Code> でサブページを追加</Tip>
          </Step>
          <Step number={3} title="タグとページリンクで繋ぐ">
            <p>
              ブロック内で <Code>#タグ名</Code> と書くとタグになります。
              <Code>{"{{ページ名}}"}</Code> と書くとページへのリンクになります。
              これらを使って、関連する情報を横断的に繋ぎましょう。
            </p>
          </Step>
          <Step number={4} title="バックリンクで振り返る">
            <p>
              ページを開くと、下部に<strong>「このページへの参照」</strong>が表示されます。
              他の日付やページからどこでこのページが言及されているか、一目で分かります。
            </p>
          </Step>
        </div>
      </Section>

      {/* タグ */}
      <Section title="タグ #">
        <p className="mb-3">
          ブロックの中で <Code>#タグ名</Code> と書くと、自動的にタグとして認識されます。
        </p>
        <ExampleBlock lines={[
          "今日の会議メモ #議事録",
          "  決定事項: リリース日は来週金曜 #リリース",
          "  TODO: ドキュメント更新 #タスク",
        ]} />
        <ul className="mt-3 space-y-1.5 text-sm text-gray-600">
          <li>- サイドバーの<strong>タグ一覧</strong>からタグをクリックすると、そのタグを含むブロックが日付順に一覧表示されます</li>
          <li>- 親ブロックのタグは<strong>子ブロックに自動継承</strong>されます。上の例では「決定事項」「TODO」のブロックにも <Code>#議事録</Code> タグが付きます</li>
          <li>- タグはブロックから削除すると、自動的にサイドバーからも消えます</li>
        </ul>
      </Section>

      {/* ページリンク */}
      <Section title="ページリンク {{}}">
        <p className="mb-3">
          <Code>{"{{ページ名}}"}</Code> と書くと、そのページへのリンクになります。クリックでジャンプできます。
        </p>
        <ExampleBlock lines={[
          "{{プロジェクトA}} の進捗確認",
          "{{プロジェクトA/設計}} のレビューが必要",
        ]} />
        <ul className="mt-3 space-y-1.5 text-sm text-gray-600">
          <li>- 存在しないページ名を書くと、<strong>自動的にページが作成</strong>されます</li>
          <li>- <Code>{"{{親/子}}"}</Code> のようにスラッシュで階層指定できます</li>
          <li>- <Code>{"{{"}</Code> と入力し始めると<strong>ページ候補がサジェスト</strong>されます</li>
          <li>- リンク先のページを開くと、バックリンクとしてこのブロックが表示されます</li>
        </ul>
      </Section>

      {/* アクション */}
      <Section title="アクション !action / !done">
        <p className="mb-3">
          ブロックの先頭に <Code>!action</Code> と書くと<strong>未完了タスク</strong>（赤丸 <span className="text-red-500 font-bold">●</span>）、
          <Code>!done</Code> と書くと<strong>完了タスク</strong>（緑丸 <span className="text-green-500 font-bold">●</span>）になります。
        </p>
        <ExampleBlock lines={[
          "!action ドキュメントを更新する",
          "!action レビュー依頼を出す",
          "!done デザインカンプ確認済み",
        ]} />
        <ul className="mt-3 space-y-1.5 text-sm text-gray-600">
          <li>- サイドバーの<strong>「全アクション」</strong>で全ページ・全日付のアクションを横断一覧できます</li>
          <li>- 完了したら <Code>!action</Code> を <Code>!done</Code> に書き換えるだけ</li>
          <li>- ページビューの右サイドバー（デスクトップ）にも、そのページのアクション一覧が表示されます</li>
        </ul>
        <Tip>シンプルなタスク管理に最適。重いタスク管理ツールは不要です</Tip>
      </Section>

      {/* テンプレート */}
      <Section title="テンプレート !template">
        <p className="mb-3">
          よく使うブロックのパターンをテンプレートとして保存し、素早く挿入できます。
        </p>
        <h4 className="text-sm font-semibold text-gray-700 mt-4 mb-2">テンプレートの作成</h4>
        <ol className="space-y-1.5 text-sm text-gray-600 list-decimal list-inside">
          <li>左上のユーザーアイコンをクリック</li>
          <li><strong>「テンプレート」</strong>を選択</li>
          <li>「新規作成」でテンプレート名を入力</li>
          <li>ブロックエディタ形式でテンプレート内容を編集</li>
        </ol>
        <h4 className="text-sm font-semibold text-gray-700 mt-4 mb-2">テンプレートの挿入</h4>
        <p className="text-sm text-gray-600 mb-2">
          エディタで <Code>!template</Code> または <Code>!t</Code> と入力すると、テンプレート一覧がサジェストされます。
          選択すると、テンプレートの内容が複数ブロックとして展開されます。
        </p>
        <h4 className="text-sm font-semibold text-gray-700 mt-4 mb-2">テンプレート例</h4>
        <div className="space-y-3">
          <TemplateExample name="日報" lines={[
            "!action 今日のタスク",
            "  ",
            "完了したこと",
            "  ",
            "明日やること",
            "  ",
          ]} />
          <TemplateExample name="議事録" lines={[
            "#議事録",
            "参加者:",
            "議題:",
            "  ",
            "決定事項:",
            "  ",
            "!action ネクストアクション",
            "  ",
          ]} />
        </div>
      </Section>

      {/* ショートカット */}
      <Section title="キーボードショートカット">
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
          <Shortcut keys="Enter" desc="新しい行を追加" />
          <Shortcut keys="Tab" desc="インデント" />
          <Shortcut keys="Shift + Tab" desc="インデント解除" />
          <Shortcut keys="Backspace (行頭)" desc="前の行と結合" />
          <Shortcut keys="Ctrl + Z" desc="元に戻す (Undo)" />
          <Shortcut keys="Ctrl + Shift + Z" desc="やり直し (Redo)" />
          <Shortcut keys="Shift + クリック" desc="複数行を選択" />
          <Shortcut keys="Delete" desc="選択した行を削除" />
          <Shortcut keys="Ctrl + C" desc="選択した行をコピー" />
          <Shortcut keys="Ctrl + X" desc="選択した行をカット" />
          <Shortcut keys="Ctrl + V" desc="ペースト（複数行対応）" />
          <Shortcut keys="Ctrl + A" desc="全行を選択" />
          <Shortcut keys="Escape" desc="選択を解除" />
        </div>
      </Section>

      {/* 活用例 */}
      <Section title="活用シナリオ">
        <div className="space-y-4">
          <Scenario
            title="毎日の振り返り日記"
            desc="日付ページに毎日の出来事・学び・感情を記録。タグで分類して後から振り返り。"
            tags={["#日記", "#学び", "#感謝"]}
          />
          <Scenario
            title="プロジェクト管理"
            desc="プロジェクトごとにページを作り、タスクを !action で管理。全アクションで横断チェック。"
            tags={["!action", "{{プロジェクト名}}", "#進捗"]}
          />
          <Scenario
            title="読書メモ"
            desc="本ごとにページを作成。気になった箇所を引用し、自分の考えをインデントで追記。"
            tags={["#読書", "#引用", "{{書籍名}}"]}
          />
          <Scenario
            title="ミーティングノート"
            desc="テンプレートで議事録フォーマットを素早く展開。決定事項とアクションアイテムを明確に。"
            tags={["#議事録", "!action", "!done"]}
          />
        </div>
      </Section>

      {/* テーマ */}
      <Section title="テーマ色の変更">
        <p className="text-sm text-gray-600">
          左上のユーザーアイコン → <strong>テーマ色</strong> から、5色（オレンジ / ブルー / パープル / グリーン / ピンク）を選べます。
          選んだテーマは自動保存され、次回以降も維持されます。
        </p>
      </Section>

      <div className="mt-8 mb-12 text-center">
        <button
          onClick={() => onNavigate("date")}
          className="rounded-lg bg-theme-500 px-6 py-2.5 text-sm font-medium text-white hover:bg-theme-600 transition"
        >
          さっそく使い始める
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-bold text-gray-800 mb-3 pb-2 border-b border-gray-200">{title}</h2>
      {children}
    </section>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 flex items-center justify-center h-7 w-7 rounded-full bg-theme-100 text-theme-600 text-sm font-bold">
        {number}
      </div>
      <div className="flex-1">
        <h3 className="text-sm font-semibold text-gray-800 mb-1">{title}</h3>
        <div className="text-sm text-gray-600">{children}</div>
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-theme-600">{children}</code>;
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg bg-theme-50 px-3 py-2 text-xs text-theme-700">
      <span className="flex-shrink-0 mt-0.5">💡</span>
      <span>{children}</span>
    </div>
  );
}

function ExampleBlock({ lines }: { lines: string[] }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-700 space-y-0.5">
      {lines.map((line, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-gray-300 select-none">&#x2022;</span>
          <span>{line || "\u00A0"}</span>
        </div>
      ))}
    </div>
  );
}

function TemplateExample({ name, lines }: { name: string; lines: string[] }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-500">
        テンプレート: {name}
      </div>
      <div className="p-3 font-mono text-xs text-gray-700 space-y-0.5">
        {lines.map((line, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-gray-300 select-none">&#x2022;</span>
            <span>{line || <span className="text-gray-300">(空行)</span>}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Shortcut({ keys, desc }: { keys: string; desc: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <kbd className="rounded bg-gray-100 border border-gray-200 px-1.5 py-0.5 text-xs font-mono text-gray-700">{keys}</kbd>
      <span className="text-gray-600 text-xs">{desc}</span>
    </div>
  );
}

function Scenario({ title, desc, tags }: { title: string; desc: string; tags: string[] }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h4 className="text-sm font-semibold text-gray-800 mb-1">{title}</h4>
      <p className="text-xs text-gray-600 mb-2">{desc}</p>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <span key={tag} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 font-mono">{tag}</span>
        ))}
      </div>
    </div>
  );
}
