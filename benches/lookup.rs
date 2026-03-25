use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use structured_public_domains::{is_known_suffix, lookup, registrable_domain};

fn bench_lookup(c: &mut Criterion) {
    let mut group = c.benchmark_group("lookup");

    let cases = [
        ("simple_com", "example.com"),
        ("nested_co_uk", "www.example.co.uk"),
        ("deep_subdomain", "a.b.c.d.example.com"),
        ("bare_tld", "com"),
        ("new_gtld", "example.app"),
        ("private_domain", "mysite.github.io"),
        ("unicode_idn", "example.xn--p1ai"),
        ("long_domain", "very.deep.subdomain.chain.example.co.uk"),
    ];

    for (name, domain) in &cases {
        group.bench_with_input(BenchmarkId::new("lookup", name), domain, |b, domain| {
            b.iter(|| lookup(black_box(domain)));
        });
    }

    group.finish();
}

fn bench_helpers(c: &mut Criterion) {
    let mut group = c.benchmark_group("helpers");

    group.bench_function("is_known_suffix", |b| {
        b.iter(|| is_known_suffix(black_box("example.com")));
    });

    group.bench_function("registrable_domain", |b| {
        b.iter(|| registrable_domain(black_box("www.example.co.uk")));
    });

    group.finish();
}

fn bench_init(c: &mut Criterion) {
    // This benchmarks repeated lookups — first call includes init
    c.bench_function("first_lookup_with_init", |b| {
        b.iter(|| lookup(black_box("example.com")));
    });
}

criterion_group!(benches, bench_lookup, bench_helpers, bench_init);
criterion_main!(benches);
