import { useAccount } from '../context/AccountContext.tsx';
import { displayAsset } from '../lib/format.ts';
import { Panel } from './Panel.tsx';

export function BalancesPanel() {
  const { balances, loading } = useAccount();
  return (
    <Panel title="Balances">
      {loading && balances.length === 0 ? (
        <p className="text-muted-tilt small mb-0">Loading…</p>
      ) : (
        <table className="table table-sm tilt-table mb-0">
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col" className="text-end">
                Available
              </th>
              <th scope="col" className="text-end">
                In orders
              </th>
            </tr>
          </thead>
          <tbody>
            {balances.map((balance) => (
              <tr key={balance.asset}>
                <th scope="row">{balance.asset}</th>
                <td className="text-end mono">{displayAsset(balance.asset, balance.available)}</td>
                <td className="text-end mono text-muted-tilt">
                  {displayAsset(balance.asset, balance.held)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
