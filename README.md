# Chirpy Starter

[![Gem Version](https://img.shields.io/gem/v/jekyll-theme-chirpy)][gem]&nbsp;
[![GitHub license](https://img.shields.io/github/license/cotes2020/chirpy-starter.svg?color=blue)][mit]

A minimal, ready-to-use template for creating a blog with the [**Chirpy**][chirpy] Jekyll theme. Get up and running in minutes with all critical files pre-configured.

## Why This Starter Exists

When installing Chirpy through [RubyGems.org][gem], Jekyll can only read a subset of theme files (`_data`, `_layouts`, `_includes`, `_sass`, `assets`) and limited `_config.yml` options from the gem. As a result, users cannot enjoy the full out-of-the-box experience that Chirpy offers.

To unlock all features, the following files must be present in your Jekyll site:

```shell
.
├── _config.yml
├── _plugins
├── _tabs
└── index.html
```

This starter bundles those files from the latest **Chirpy** release along with a [CD][CD] workflow, so you can start writing immediately.

## Usage

Check out the [theme's docs](https://github.com/cotes2020/jekyll-theme-chirpy/wiki).

## 덜 붐비는 칸 (`/subway/`)

블로그와 함께 배포되는 지하철 혼잡도 예측 도구입니다. 역·방향·요일·시간대별 예상
재차율과 가장 여유로운 칸을 알려줍니다.

```
subway/
├── index.html        # 앱 화면
├── app.css, app.js   # 프런트엔드 (의존성 없음)
└── data/             # 사전 계산된 JSON (index.json, line-1..9.json)

tools/subway/         # 데이터 생성기 (Jekyll 빌드에서 제외됨)
├── stations.py       # 1~9호선 노선·역 정의, 역 특성 프로파일
└── build_data.py     # 혼잡도 시뮬레이션 → subway/data/*.json
```

데이터를 다시 만들려면:

```console
$ cd tools/subway && python3 build_data.py
```

정적 사이트라 서버 계산이 불가능하므로, 노선 × 방향 × 요일 × 30분 슬롯의 예상
재차율을 미리 계산해 JSON으로 배포하고 브라우저는 조회만 합니다. 값은 실측
승하차 통계가 아니라 역세권 성격 기반 추정 모델이며, 산출 방식은 앱 하단의
"이 숫자는 어떻게 나온 건가요?"와 `build_data.py` 상단 주석에 정리해 두었습니다.

## Contributing

This repository is automatically updated with new releases from the theme repository. If you encounter any issues or want to contribute to its improvement, please visit the [theme repository][chirpy] to provide feedback.

## License

This work is published under [MIT][mit] License.

[gem]: https://rubygems.org/gems/jekyll-theme-chirpy
[chirpy]: https://github.com/cotes2020/jekyll-theme-chirpy/
[CD]: https://en.wikipedia.org/wiki/Continuous_deployment
[mit]: https://github.com/cotes2020/chirpy-starter/blob/master/LICENSE
