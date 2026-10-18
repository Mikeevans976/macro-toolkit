"""
Unit tests for funding_models: the book's worked numbers (H&S Ch 11, 13, 18),
the term-rate model's identities, and haircut bucket lookups against the
schedules in data/haircut_schedules.json.
"""
import pytest

from funding_models import (
    adjusted_cds,
    haircut_drag_bp,
    haircut_pct,
    implied_cost_of_equity,
    issuer_haircut_class,
    load_schedules,
    secured_unsecured_basis_bp,
    term_rate,
)


class TestCdsAdjustment:
    def test_factors(self):
        assert adjusted_cds(100.0, 'physical')['adjusted_bp'] == pytest.approx(39.0)
        assert adjusted_cds(100.0, 'cash')['adjusted_bp'] == pytest.approx(45.0)

    def test_scenarios(self):
        sc = {s['case']: s['adjusted_bp'] for s in adjusted_cds(80.0)['scenarios']}
        assert sc == pytest.approx({'low': 24.0, 'mid': 36.0, 'high': 48.0})

    def test_unknown_settlement(self):
        with pytest.raises(ValueError):
            adjusted_cds(50.0, 'swap')


class TestSecuredUnsecured:
    def test_book_example(self):
        # 10% cost of equity × 20% risk weight × 8% capital = 16bp
        assert secured_unsecured_basis_bp(0.10, 0.20, 0.08) == pytest.approx(16.0)


class TestTermRate:
    def test_no_credit_no_capital_is_repo(self):
        out = term_rate(0.02, pd=0.0, recovery=0.4, q=0.2, d=0.08, g=0.05, b=0.05)
        assert out['rate'] == pytest.approx(0.02)
        assert out['spread_to_repo_bp'] == pytest.approx(0.0, abs=1e-9)

    def test_components_sum(self):
        out = term_rate(0.019, pd=0.0025, recovery=0.4, q=0.2, d=0.08, g=0.10, b=0.019)
        assert out['funding'] + out['credit'] + out['capital'] == pytest.approx(out['rate'])
        # credit ≈ expected loss, capital ≈ q·d·(g − b)
        assert out['credit'] == pytest.approx(0.0015, rel=0.01)
        assert out['capital'] == pytest.approx(0.2 * 0.08 * (0.10 - 0.019), rel=0.01)

    def test_implied_cost_of_equity_round_trip(self):
        args = dict(repo=0.019, pd=0.003, recovery=0.4, q=0.2, d=0.08, b=0.019)
        L = term_rate(g=0.12, **args)['rate']
        assert implied_cost_of_equity(L, **args) == pytest.approx(0.12, abs=1e-12)


class TestHaircuts:
    def test_ecb_buckets(self):
        assert haircut_pct('ecb', 'cqs12', 9.99) == 3.0
        assert haircut_pct('ecb', 'cqs12', 10.0) == 4.0
        assert haircut_pct('ecb', 'cqs12', 30.0) == 6.0
        assert haircut_pct('ecb', 'cqs12', 30.0, zero=True) == 9.0
        assert haircut_pct('ecb', 'cqs3', 10.0) == 12.5

    def test_fed_uses_duration(self):
        # A 30y bond with 15y duration and one with 8y duration land in different buckets
        assert haircut_pct('fed', 'ust', 30.0, duration=15.0) == 5.0
        assert haircut_pct('fed', 'ust', 30.0, duration=8.0) == 3.0
        assert haircut_pct('fed', 'ust', 30.0, duration=15.0, zero=True) == 6.0

    def test_boe(self):
        assert haircut_pct('boe', 'uk', 25.0) == 8.5
        assert haircut_pct('boe', 'uk', 25.0, zero=True) == 10.5
        assert haircut_pct('boe', 'uk', 0.5) == 0.5

    def test_drag_book_example(self):
        # 2% haircut × 5% excess funding cost ≈ 10bp (H&S Fig 12.4)
        assert haircut_drag_bp(2.0, 500.0) == pytest.approx(10.0)

    def test_issuer_mapping(self):
        assert issuer_haircut_class('BTP') == ('ecb', 'cqs12')
        assert issuer_haircut_class('BTP', alternative=True) == ('ecb', 'cqs3')
        assert issuer_haircut_class('Bund', alternative=True) == ('ecb', 'cqs12')
        assert issuer_haircut_class('JGB') == (None, None)

    def test_schedule_shapes(self):
        for s in load_schedules()['schedules'].values():
            assert s['as_of'] and s['url'].startswith('https://')
            for cls in s['classes'].values():
                assert len(cls['coupon']) == len(cls['zero']) == len(s['edges'])
                assert cls['coupon'] == sorted(cls['coupon']) and cls['zero'] == sorted(cls['zero'])
