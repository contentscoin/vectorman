# 인수인계서

작성 시점의 `main`: `b81a87c`. 이 문서는 검증된 사실만 담고, 확인하지 못한 것은 확인하지 못했다고 적는다.

기술적 배경은 [README](README.md)에 있다. 이 문서는 README에 없는 것, 즉 **지금 어디까지 됐고 무엇이 막혀 있으며 어디서 시간을 잃게 되는지**를 다룬다.

---

## 1. 한 줄 요약

엔진·웹 스튜디오·MCP 서버가 완성되어 검증까지 끝났고, 배포 파이프라인은 실제 CI 러너에서 끝까지 통과한다. **다만 공개 URL은 아직 확인되지 않았다.** 남은 것은 Vercel 프로젝트 설정 확인 하나다.

---

## 2. 현재 상태

| 항목 | 상태 |
|---|---|
| 저장소 | [contentscoin/vectorman](https://github.com/contentscoin/vectorman), `main` = `b81a87c` |
| CI (main) | [run 30640838151](https://github.com/contentscoin/vectorman/actions/runs/30640838151) 통과 |
| 검증 | `pnpm run verify:all` → **488 checks / 10 suites**, 전부 통과 |
| PR | [#1](https://github.com/contentscoin/vectorman/pull/1) 머지, [#2](https://github.com/contentscoin/vectorman/pull/2) 머지 |
| 정적 사이트 | `apps/web/out`, 1.3 MB |
| MCP 컨테이너 | `perfectvector/mcp:0.1.0`, 272.9 MB, 비특권, stdio |
| npm 패키지 | `pnpm run pack` → tarball 2개 (미게시) |
| 공개 URL | **없음 / 미확인** — 3절 참고 |

스위트별 개수: 엔진 73, 스트로크 51, 실사 39, MCP 80, 배치 53, 패키징 24, 브라우저(서버 빌드) 50, 브라우저(익스포트 산출물) 59, Vercel 배포 설정 38, 컨테이너 21.

CI 잡 4개: `verify`, `container`, `publish-site`, `publish-packages`. 뒤 두 개는 토큰이 없으면 안내 메시지를 출력하고 건너뛴다. `publish-site`가 **실제로 진입하는 것까지 확인**했다 ([run 30635079430](https://github.com/contentscoin/vectorman/actions/runs/30635079430) — 잡은 성공, 배포 3단계만 스킵).

---

## 3. 지금 막혀 있는 것

### 3.1 공개 URL (최우선)

Vercel 프로젝트가 연결되어 있고 `main`의 빌드는 로컬 재현 기준으로 성공한다. 그런데 마지막으로 확인된 시점에 도메인이 `404 NOT_FOUND`였다.

- **당시 원인은 규명됐고 고쳐졌다**: 엔진이 웹 앱보다 먼저 빌드되지 않아 `Can't resolve '@perfectvector/core'`로 빌드가 실패했고, 실패한 빌드는 배포를 만들지 않으므로 도메인이 404였다. PR #2가 이를 고쳤고 머지됐다.
- **재배포 결과는 확인하지 못했다.** 이 작업 환경에는 Vercel 자격증명이 없고 프로젝트의 실제 도메인도 모른다. 추측성 도메인 몇 개를 조회해 봤지만 프로젝트명을 모르는 상태의 추측이라 근거가 되지 않는다.

**먼저 할 일:** Vercel 대시보드에서 최신 배포 상태를 본다. 성공했다면 URL이 나온다. 실패했다면 빌드 로그가 필요하다.

### 3.2 확인이 필요한 가설: Root Directory

실패한 빌드 로그에서 이 줄만 있었다.

```
> @perfectvector/web@0.1.0 build:static /vercel/path0/apps/web
```

`vercel.json`의 `buildCommand`는 루트 스크립트다. 루트에서 실행됐다면 그 앞에 모노레포 스크립트와 `fixtures`/`samples` 단계가 찍혀야 하는데 없었고, install 종료 후 0.5초밖에 지나지 않았다. 즉 Vercel이 `apps/web`에서 web 패키지 스크립트를 직접 실행했다.

**Project Settings → Build & Deployment → Root Directory** 를 확인할 것. **비어 있어야**(= 저장소 루트) 한다. `apps/web`이면:

- `vercel.json`은 Root Directory에서 읽히므로 루트 설정이 무시된다 → 검증해 둔 CSP·캐시 헤더가 전부 적용되지 않는다
- `outputDirectory: apps/web/out`의 기준이 어긋난다 (그 경우 `out`이어야 함)
- 빌드가 성공해도 산출물을 못 찾아 404가 날 수 있다

`apps/web/vercel.json`을 따로 만들어 맞추는 방식은 권하지 않는다. 설정이 두 곳으로 갈라지면 검증되는 쪽은 하나뿐이고 나머지는 조용히 낡는다. 같은 이유로 `netlify.toml`을 삭제했다.

### 3.3 자격증명 (선택)

CI에서 배포/게시하려면 GitHub → Settings → Secrets and variables → Actions 에 추가한다.

| 시크릿 | 용도 |
|---|---|
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | `main` push 시 사이트 배포 |
| `NPM_TOKEN` | `v*` 태그 push 시 패키지 게시 |

Vercel 대시보드의 Git 연동만 쓸 경우 토큰은 필요 없다.

---

## 4. 실행 방법

```bash
pnpm run install:deps   # pnpm install --frozen-lockfile --ignore-scripts
pnpm run build          # 엔진 + MCP 서버
pnpm run build:web      # 웹 (서버 빌드)
pnpm run build:static   # 웹 (배포용 정적 익스포트) → apps/web/out
pnpm run dev:web        # http://localhost:3000
pnpm run verify:all     # 488 checks
```

개별 스위트는 README의 Verification 절에 있다. 배포 관련만 다시 적으면:

```bash
pnpm run verify:vercel   # Vercel의 install/build 명령을 pristine 사본에서 실행
pnpm run verify:docker   # 이미지 빌드 후 stdio로 실제 구동
pnpm run verify:package  # tarball을 빈 디렉터리에 설치해 구동
```

---

## 5. 반드시 알아야 할 함정

여기서 시간이 사라진다. 전부 실제로 겪은 것이다.

### 5.1 `pnpm install`에 `--ignore-scripts`가 필수다

없으면 **exit 1** 이고, pnpm이 `pnpm run` 앞에 install 검사를 하기 때문에 다른 모든 스크립트까지 같이 죽는다.

원인은 Next가 끌고 오는 sharp 0.34.5의 빌드 스크립트다. 이 앱은 Next 이미지 최적화를 쓰지 않는다. MCP가 쓰는 sharp 0.35.3은 install 스크립트가 아예 없고 prebuilt 바이너리로 동작한다.

시도했으나 **효과가 없던 것들**: `onlyBuiltDependencies`(이전에 기록돼 있었고 새 트리에서 아무 효과 없음), `ignoredBuiltDependencies`, `.npmrc`의 `ignore-scripts=true`. `dangerouslyAllowAllBuilds: true`는 동작하지만 모든 의존성에 설치 시점 임의 코드 실행을 허용하므로 거부했다. 자세한 근거는 [pnpm-workspace.yaml](pnpm-workspace.yaml) 주석에 있다.

주의: 최신 상태인 트리에서는 pnpm이 install 단계를 건너뛰고 아무것도 보고하지 않는다. 그래서 설정을 바꾸면 **고쳐진 것처럼 보인다.** 반드시 새 트리에서 확인할 것.

### 5.2 게시에는 `pnpm pack`을 쓴다. `npm pack`은 안 된다

`npm pack`은 매니페스트에 `"@perfectvector/core": "workspace:*"`를 남긴다. `workspace:`는 pnpm 전용 프로토콜이라 어떤 레지스트리도 해석하지 못하고, tarball은 어디에도 설치되지 않으며 `npx @perfectvector/mcp`는 시작조차 못 한다. `pnpm pack`은 실제 버전으로 치환한다. `verify:package`가 이를 단정한다.

### 5.3 빌드 상태가 검증에 새어든다 — 이 저장소에서 네 번 발생했다

가장 값비싼 패턴이다. 로컬에서는 상태가 항상 존재하므로 **원리적으로 잡히지 않는다.** 네 사례:

1. `apps/web/.next` — `build:web`과 `build:static`이 같은 디렉터리에 쓴다. 마지막에 무엇을 빌드했는지에 따라 브라우저 스위트가 다른 대상을 검증했다.
2. pnpm이 `node_modules/.modules.yaml`에 기록된 과거 빌드 결정을 재생했다 (5.1의 착시 원인).
3. `packages/core/dist` 없음 → 타입체크 시 엔진 export가 전부 암묵적 `any` (TS7006 30건). CI가 잡았다.
4. `packages/core/dist` 없음 → 번들 시 `Can't resolve '@perfectvector/core'`. **Vercel이 잡았다.**

근본 원인은 제외 목록으로 "clean" 트리를 만든 것이었다. 지금은 `git archive HEAD`로 추적 파일만 복사하고, 사본에 `node_modules`·`dist`·`.next`·`out`이 없음을 단정한다. **새 트리를 만들 일이 생기면 제외 목록을 쓰지 말고 git에게 물을 것.**

현재 방어선:
- `verify:all`이 각 웹 타깃을 검증 직전에 빌드한다
- `verify:web`(서버 타깃)은 `.next`에 익스포트가 들어 있으면 타임아웃 대신 즉시 실행 가능한 메시지를 낸다
- `typecheck`이 엔진을 먼저 빌드한다
- 웹 빌드가 엔진을 먼저 빌드한다 (루트 스크립트와 web 패키지 스크립트 **양쪽**에 있다 — 호스트가 web 패키지 스크립트를 직접 부를 수 있고, Vercel이 실제로 그렇게 했다)

### 5.4 `main`에 직접 푸시할 수 없다

푸시 도구가 거부한다:

```
Refusing to push CI configuration file(s) [.github/workflows/ci.yml]
directly to protected branch 'main'.
```

diff가 아니라 **대상 트리에 CI 설정이 존재하는지**를 본다. `main`에 워크플로가 있으므로 모든 푸시가 막힌다. 우회하지 말 것 — 리뷰를 건너뛴 워크플로가 시크릿 접근 권한으로 즉시 실행되는 것을 막는 장치이고, `VERCEL_TOKEN`을 넣을 예정이라면 실제로 의미가 있다.

**머지는 GitHub UI 또는 로컬 git에서 해야 한다.** 브랜치 푸시와 PR 생성은 도구로 된다.

### 5.5 GitHub Actions에서 스텝 레벨 `if`는 스텝 `env`보다 먼저 평가된다

시크릿을 스텝 안에 선언하면 조건에서는 빈 문자열로 읽힌다. 토큰을 넣어도 **영구히, 조용히** 건너뛴다. 배포 시크릿은 반드시 잡 레벨에 둔다. 현재 워크플로는 그렇게 되어 있다.

### 5.6 배포 게이트에 브랜치 이름을 하드코딩하지 말 것

`refs/heads/main`으로 되어 있었고 당시 브랜치는 `master`였다. 배포 잡이 한 번도 실행되지 않으면서 CI는 계속 초록불이었다. 지금은 `github.ref_name == github.event.repository.default_branch`로 비교한다.

### 5.7 성능 단정문에 특정 머신의 측정값을 쓰지 말 것

배치 스위트가 워커 7개에 1.8배를 요구했다. 8코어 개발 머신의 값이었고, 2코어 러너에서 1.44배가 나와 **정상 코드가 실패**했다. 지금은 트레이싱 시간 합 ÷ 실제 경과 시간으로 병렬성을 증명한다 (직렬화되면 1.0 근처, 하드웨어 무관). 벽시계 절감은 `availableParallelism()`에 맞춘 임계값으로 따로 본다.

### 5.8 기타

- 쉘: `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | tail -1)/bin:$PATH"`, `export CI=true`
- 컨테이너 바인드 마운트는 SELinux 호스트에서 `:z`가 없으면 읽지 못한다. 이미지는 uid 1000으로 돌므로 마운트 디렉터리가 쓰기 가능해야 한다
- 정적 서버는 `.js`를 `text/javascript`로 주어야 한다. 아니면 브라우저가 모듈 워커를 거부한다
- `apps/web/src/lib/sample-stats.json`은 `build:web`이 재생성한다. 측정 타이밍만 바뀌는 노이즈 diff가 자주 생긴다 — 커밋 전 확인할 것
- 워크플로 주석에 백틱을 쓰지 말 것. 푸시 스캐너가 `` `env` ``를 환경변수 덤프 명령으로 읽어 푸시를 거부한다

---

## 6. 미해결 / 알려진 미지

### 6.1 원인이 규명되지 않은 색상 레이어 소실 버그 (기술 부채 1순위)

약 1/1000 빈도로 색상 레이어 하나가 사라지던 문제가 있었다. `RegionLoop`에서 캐시된 `signedArea`/`isHole`을 제거해 증상은 사라졌고, 불변식 가드와 `droppedRegions`/`repairedRegions` 카운터를 방어선으로 남겨 두 값이 0임을 단정한다.

**메커니즘은 설명되지 않았다.** README도 그렇게 적고 있다. 설명되지 않은 수정은 다시 깨질 수 있는 수정이므로, 남은 작업 중 가장 값진 것은 이것을 규명하는 일이다.

### 6.2 CI 러너의 개별 검증 개수를 읽지 못했다

각 스위트 스크립트가 exit 0이었으므로 통과는 확실하다 (모든 스크립트는 검증 하나라도 실패하면 exit 1). 다만 성공한 잡의 로그 다운로드는 인증이 필요해 러너에서의 개별 개수는 확인하지 못했다. 로컬은 488/488이다.

### 6.3 실제 배포본에 대한 브라우저 검증이 남았다

`verify:web:static`은 로컬에서 익스포트 산출물을 검증한다. **실제 배포된 사이트**를 대상으로 같은 스위트를 돌리는 것이 마지막 검증 고리다. URL이 나오면 그때 해야 한다. 확인할 것: 워커 로딩, 5종 다운로드 포맷, 저장된 프리셋, 라우팅, 그리고 응답 헤더가 `vercel.json`과 일치하는지.

---

## 7. 저장소 구조

```
packages/core       엔진. 9단계 파이프라인, 평면 크랙-에지 추적기, Bézier 피팅
packages/mcp        MCP 서버. stdio 툴 7개 + 리소스 2개, worker_threads 배치 풀
                    Dockerfile 포함 (런타임 스테이지가 패킹된 tarball을 설치)
apps/web            Next.js 15. 랜딩 + 스튜디오. 변환은 전부 브라우저 Web Worker
scripts/            검증 스위트 10개 + 픽스처/샘플 생성
vercel.json         배포 설정의 단일 출처. 헤더는 브라우저 스위트가 실제로 적용해 검증
.github/workflows/  CI
```

`vercel.json`의 헤더는 장식이 아니다. `scripts/verify-web.mjs`가 이 파일을 파싱해 익스포트 산출물 앞에 실제로 얹어 서빙하므로, 워커나 미리보기·다운로드용 object URL을 막는 CSP는 브라우저 스위트에서 실패한다.

---

## 8. 다음 작업 순서 (권장)

1. Vercel 최신 배포 상태 확인 → URL 확보. 실패면 빌드 로그 확보
2. Root Directory가 저장소 루트인지 확인 (3.2)
3. URL 확보 후 실제 사이트에 브라우저 스위트 실행 (6.3)
4. 필요하면 시크릿 추가해 CI 배포/게시 활성화 (3.3)
5. 색상 레이어 소실 버그 규명 (6.1)
